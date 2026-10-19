#!/usr/bin/env node
// rynth_combatparity_test.cjs — C# CombatManager parity regression tests for
// rynth/combat_loop.js. Encodes the 4 CONFIRMED divergences from the netwasm
// CombatScoring parity run (docs/rynth-integration/netwasm-spike/CombatScoring/
// README.md "Genuine findings" 1/2/3/5, fixtures.json scenarios
// stickiness-switch / scan-grace-with-alternative /
// scan-grace-hold-no-alternative / recently-killed-6s) with the C#-correct
// expected outcome, plus regression guards that the fixes didn't break real
// kill confirmation or the P12 prediction gate.
//
// C# authority: ~/rynthnav-inputs/rynthsuite/Plugins/RynthCore.Plugin.RynthAi/
// Combat/CombatManager.cs — cited per scenario below.
//
// 2026-10-19: the VTank options the VT layer feeds through `loop.optFn` —
// T3 MonsterDisengageRange hysteresis (TargetScoring.cs DisengageDistance /
// the "out of range" validation drop / the engaged-target scan range),
// AttackMinDistance and TargetLock (MOSS CombatTargetSelection: priority
// first, then the selection) — including the netBrain "on" seat (the C#
// input's disengage / user-never-attack feed; the selection outranks the C#
// pick). Without optFn every scenario above is the literal path.
//
// Run: node rynth_combatparity_test.cjs   (exits 1 on any FAIL)

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const COMBAT_LOOP = path.join(__dirname, "rynth", "combat_loop.js");
const LB = 0xa9b40015; // shared landblock cell for all fixtures

// Mock RynthWebHost — same contract subset as the netwasm parity harness
// (CombatScoring/parity_check.cjs makeHost), extended with the tick()-level
// calls (mode/stick/query) so full tick() can be driven.
function makeHost(entities, opts = {}) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const calls = { stuck: [], stopStick: 0, queried: [], melee: [] };
  return {
    calls,
    byId,
    IsPlayerReady: () => true,
    TryGetPlayerPose: () => ({ objCellId: LB >>> 0, x: 96, y: 96, z: 0, heading: null }),
    NearbyGuids: () => entities.filter((e) => !e.gone).map((e) => e.id),
    ObjectIsPlayer: () => false,
    TryGetObjectIntProperty: (g, stype) => (stype === 1 ? byId.get(g)?.itemType ?? 16 : undefined),
    ObjectIsAttackable: (g) => byId.get(g)?.attackable ?? true,
    TryGetTargetHealthFraction: (g) => {
      const e = byId.get(g);
      if (!e || e.gone) return -1;
      return e.hf ?? 1;
    },
    TryGetObjectPosition: (g) => {
      const e = byId.get(g);
      if (!e || e.gone || e.noPos) return null;
      return { objCellId: LB >>> 0, x: e.x, y: e.y, z: e.z ?? 0 };
    },
    TryGetObjectName: (g) => byId.get(g)?.name ?? null,
    GetCurrentCombatMode: () => opts.mode ?? 2, // melee established
    StickToObject: (g) => calls.stuck.push(g),
    StopStick: () => calls.stopStick++,
    QueryHealth: (g) => calls.queried.push(g),
    MeleeAttack: (g) => calls.melee.push(g),
    GetCastBusyState: () => 0,
    has: () => false,
    s: {},
  };
}

const results = [];
function check(name, cite, cond, detail) {
  results.push({ name, cite, ok: !!cond, detail: detail || "" });
}

async function main() {
  // combat_loop.js is ESM with a .js extension and no "type":"module" above
  // it — copy to a temp .mjs so Node's loader classifies it (same trick as
  // the netwasm parity harness). The bytes tested are the repo file's.
  const src = fs.readFileSync(COMBAT_LOOP, "utf8");
  const tmp = path.join(os.tmpdir(), `combat_loop_paritytest_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  let RynthCombatLoop;
  try {
    ({ RynthCombatLoop } = await import("file://" + tmp));
  } finally {
    fs.unlinkSync(tmp);
  }
  // Also load the real RynthWebHost for the T4 attackability fail-open test.
  const whSrc = fs.readFileSync(path.join(__dirname, "rynth", "webhost.js"), "utf8");
  const whTmp = path.join(os.tmpdir(), `webhost_paritytest_${process.pid}.mjs`);
  fs.writeFileSync(whTmp, whSrc);
  let RynthWebHost;
  try {
    ({ RynthWebHost } = await import("file://" + whTmp));
  } finally {
    fs.unlinkSync(whTmp);
  }
  // …and the netBrain shadow harness (shadowTick/diag; no bundle is loaded —
  // the TargetLock-under-"on" scenario drives it with a fake brain).
  const nbTmp = path.join(os.tmpdir(), `netbrain_paritytest_${process.pid}.mjs`);
  fs.writeFileSync(nbTmp, fs.readFileSync(path.join(__dirname, "rynth", "netbrain.js"), "utf8"));
  let nbModule;
  try {
    nbModule = await import("file://" + nbTmp);
  } finally {
    fs.unlinkSync(nbTmp);
  }

  const realNow = Date.now;
  const NOW = 1_000_000;
  const frozen = (ms) => { Date.now = () => ms; };
  const mkLoop = (host) => new RynthCombatLoop(host, { log: () => {} });

  try {
    // ── 1. T9 stickiness scale (fixture stickiness-switch) ──────────────
    // C# TARGET_SWITCH_STICKINESS=25.0 (CombatManager.cs:344) on the
    // 2-pts/yd ScoreCandidate distance scale (CombatManager.cs:2215,
    // MonsterRange default 50 — LegacyUiSettings.cs:105): a 23yd-closer
    // alternative gains +46 > 25 -> C# switches. JS scores 1 pt/yd, so the
    // scale-equivalent threshold is 12.5; the old 25 held (~2x too sticky).
    {
      const host = makeHost([
        { id: 0x1000000d, name: "Shreth", x: 96, y: 131 }, // locked, 35yd
        { id: 0x1000000e, name: "Shreth", x: 96, y: 108 }, // alt, 12yd
      ]);
      const loop = mkLoop(host);
      loop.locked = 0x1000000d;
      loop.lastSeenLockedAt = NOW;
      frozen(NOW);
      const sel = loop._selectTarget();
      check(
        "T9 stickiness-switch: 23yd-closer alt steals the lock",
        "CombatManager.cs:344,:2215 vs combat_loop.js TARGET_SWITCH_STICKINESS",
        sel === 0x1000000e,
        `selected ${sel.toString(16)} want 1000000e`
      );
    }

    // ── 1b. T9 flap guard: a barely-better alt must NOT steal ───────────
    // 5yd-closer alt: C# +10 < 25 holds; JS +5 < 12.5 holds. Guards the
    // constant against overshooting (e.g. dropping stickiness to 0).
    {
      const host = makeHost([
        { id: 0x1000000d, name: "Shreth", x: 96, y: 116 }, // locked, 20yd
        { id: 0x1000000e, name: "Shreth", x: 96, y: 111 }, // alt, 15yd
      ]);
      const loop = mkLoop(host);
      loop.locked = 0x1000000d;
      loop.lastSeenLockedAt = NOW;
      frozen(NOW);
      const sel = loop._selectTarget();
      check(
        "T9 near-tie holds the lock (no flapping)",
        "CombatManager.cs:343-344 anti-flap intent",
        sel === 0x1000000d,
        `selected ${sel.toString(16)} want 1000000d`
      );
    }

    // ── 2. T10 grace vs immediate re-lock (fixture scan-grace-with-alternative)
    // C# grace only RETAINS through an EMPTY scan; an absent lock is not a
    // candidate in HandleCombatTrigger (no +25) so a visible alternative
    // re-locks IMMEDIATELY (CombatManager.cs:2170-2189; grace :1774-1783).
    // Old JS returned the locked id unconditionally through the full 1500ms.
    {
      const host = makeHost([
        { id: 0x10000013, name: "Tumerok Scout", x: 96, y: 114, gone: true }, // locked, left scan
        { id: 0x10000014, name: "Tumerok Warrior", x: 96, y: 118 }, // alt, 22yd
      ]);
      const loop = mkLoop(host);
      loop.locked = 0x10000013;
      loop.lastSeenLockedAt = NOW; // grace window is OPEN
      frozen(NOW + 100); // 100ms later — well inside 1500ms
      const sel = loop._selectTarget();
      check(
        "T10 lock left scan + alternative visible: immediate re-lock",
        "CombatManager.cs:2170-2189 vs combat_loop.js _selectTarget grace gate",
        sel === 0x10000014,
        `selected ${sel.toString(16)} want 10000014`
      );
      // Full tick(): the stick must FOLLOW the re-lock even though state is
      // already "ATTACK" (else the body keeps chasing the vanished mob).
      const loop2 = mkLoop(host);
      loop2.locked = 0x10000013;
      loop2.lastSeenLockedAt = NOW;
      loop2.state = "ATTACK";
      loop2._stuckTo = 0x10000013;
      frozen(NOW + 100);
      loop2.tick();
      check(
        "T10 re-lock re-issues StickToObject on the new target",
        "C# per-tick attack path re-targets; combat_loop.js tick() re-stick",
        loop2.locked === 0x10000014 && host.calls.stuck.includes(0x10000014),
        `locked=${loop2.locked.toString(16)} stuck=[${host.calls.stuck.map((g) => g.toString(16))}]`
      );
    }

    // ── 3. T12 phantom kill (fixture scan-grace-hold-no-alternative) ────
    // Locked target vanished from the world snapshot, nothing else scanned.
    // C#: world-filter null = transient miss -> keep lock through grace,
    // NO kill (CombatManager.cs:1739-1741,:1786). Old JS tick()
    // kill-confirmed on !pos -> phantom kill + TTL suppression of a live mob.
    {
      const host = makeHost([
        { id: 0x10000011, name: "Rat", x: 96, y: 110, gone: true }, // vanished this tick
      ]);
      const loop = mkLoop(host);
      loop.locked = 0x10000011;
      loop.lastSeenLockedAt = NOW;
      frozen(NOW + 100);
      loop.tick();
      check(
        "T12 transient vanish: lock held through grace, no phantom kill",
        "CombatManager.cs:1739-1741,:1786 vs combat_loop.js tick() kill branch",
        loop.locked === 0x10000011 && loop.kills === 0 && !loop.recentlyKilled.has(0x10000011),
        `locked=${loop.locked.toString(16)} kills=${loop.kills} rkHas=${loop.recentlyKilled.has(0x10000011)}`
      );
      // Grace expiry: still vanished 1600ms later -> dropped, still kill-free.
      frozen(NOW + 1700);
      loop.tick();
      check(
        "T12 grace expiry: dropped kill-free (no TTL suppression)",
        "CombatManager.cs:1779-1780 DropTarget('scan grace expired')",
        loop.locked === 0 && loop.kills === 0 && !loop.recentlyKilled.has(0x10000011),
        `locked=${loop.locked.toString(16)} kills=${loop.kills} rkHas=${loop.recentlyKilled.has(0x10000011)}`
      );
    }

    // ── 4. T13 recently-killed TTL (fixture recently-killed-6s) ─────────
    // Kill signal 6s ago: C# RECENTLY_KILLED_SUPPRESS_MS=4000
    // (CombatManager.cs:234, report 11 T13) -> re-acquirable, nearest wins.
    // Old JS 30_000 excluded it for another 24s.
    {
      const host = makeHost([
        { id: 0x10000015, name: "Drudge Ravener", x: 96, y: 106 }, // 10yd, killed 6s ago
        { id: 0x10000016, name: "Drudge Ravener", x: 96, y: 121 }, // 25yd
      ]);
      const loop = mkLoop(host);
      loop.recentlyKilled.set(0x10000015, NOW - 6000);
      frozen(NOW);
      const sel = loop._selectTarget();
      check(
        "T13 killed-6s-ago mob is re-acquirable (TTL 4000, not 30000)",
        "CombatManager.cs:234 vs combat_loop.js RECENTLY_KILLED_TTL_MS",
        sel === 0x10000015,
        `selected ${sel.toString(16)} want 10000015`
      );
      // Inside the 4s window it must STILL be suppressed.
      const loop2 = mkLoop(host);
      loop2.recentlyKilled.set(0x10000015, NOW - 3000);
      frozen(NOW);
      const sel2 = loop2._selectTarget();
      check(
        "T13 killed-3s-ago mob still suppressed (dead-not-yet-corpse guard)",
        "CombatManager.cs:225-234 suppression rationale",
        sel2 === 0x10000016,
        `selected ${sel2.toString(16)} want 10000016`
      );
    }

    // ── 5a. Regression: hp=0 still kill-confirms, same-tick re-lock ─────
    // C# validation drops the hp=0 lock and HandleCombatTrigger re-locks the
    // alternative in the SAME tick (CombatManager.cs:1733,:1744).
    {
      const host = makeHost([
        { id: 0x10000021, name: "Mosswart", x: 96, y: 104, hf: 0 }, // locked, died
        { id: 0x10000022, name: "Mosswart", x: 96, y: 112 }, // alt, 16yd
      ]);
      const loop = mkLoop(host);
      loop.locked = 0x10000021;
      loop.lastSeenLockedAt = NOW;
      frozen(NOW);
      loop.tick();
      check(
        "hp=0 kill confirmed + same-tick re-lock + re-stick on the alt",
        "CombatManager.cs:1733,:1744 same-tick cadence",
        loop.kills === 1 &&
          loop.recentlyKilled.has(0x10000021) &&
          loop.locked === 0x10000022 &&
          host.calls.stuck.includes(0x10000022),
        `kills=${loop.kills} locked=${loop.locked.toString(16)} stuck=[${host.calls.stuck.map((g) => g.toString(16))}]`
      );
    }

    // ── 5b. P12 prediction gate: >=3 samples AND 0.80 confidence ────────
    // KILL_MIN_SAMPLES=3 / KILL_CONFIDENCE=0.8 (combat_loop.js _predictKill);
    // a transient 2-sample model must NOT arm a prediction.
    {
      const host = makeHost([{ id: 0x10000031, name: "Skeleton", x: 96, y: 106, hf: 0.1 }]);
      const loop = mkLoop(host);
      loop.locked = 0x10000031;
      loop.damageModel.set(0x10000031, { hits: 2, totalDamage: 40, maxHp: 100 });
      const at2 = loop._predictKill(); // remHP 10 <= 16 but only 2 samples
      loop.damageModel.set(0x10000031, { hits: 3, totalDamage: 60, maxHp: 100 });
      const at3 = loop._predictKill(); // remHP 10 <= avg20*0.8=16, 3 samples
      host.byId.get(0x10000031).hf = 0.17; // remHP 17 > 16
      const above = loop._predictKill();
      check(
        "P12 gate: no prediction at 2 samples; arms at 3 within 0.80*avg",
        "combat_loop.js _predictKill KILL_MIN_SAMPLES/KILL_CONFIDENCE",
        at2 === false && at3 === true && above === false,
        `at2=${at2} at3=${at3} aboveThreshold=${above}`
      );
    }

    // ── 6. T4 attackability FAIL-OPEN (webhost.js ObjectIsAttackable) ───
    // C#/RynthAi's anti-stall discipline: `if (HasObjectIsAttackable &&
    // !ObjectIsAttackable(id)) continue;` (CombatManager.cs:610) — a target is
    // excluded ONLY when its desc flags ARE present AND the attackable bit is
    // clear. An object whose ObjectDescriptionEvent hasn't streamed yet
    // (flags absent) is treated ATTACKABLE, so the bot doesn't "stare at a
    // monster for 3s" through the post-spawn/post-login window (report 11 T4;
    // combat_loop.js:177 `if (!h.ObjectIsAttackable(g)) continue;`). The old
    // webhost coalesced absent flags to 0 and failed CLOSED. Cases:
    //   (a) flags absent (undefined)          -> attackable TRUE (fail-open)
    //   (b) flags present, no attackable bit  -> attackable FALSE
    //   (c) flags present with attackable bit -> attackable TRUE
    //   (d) capability entirely absent        -> attackable TRUE (degrade-open)
    {
      const ODF_ATTACKABLE = 0x10;
      const ODF_PLAYER = 0x08;
      // Session handle where guid 0xA: no desc yet, 0xB: vendor (player bit
      // only, not attackable), 0xC: live monster (attackable bit set).
      const flagsById = { 0xa: undefined, 0xb: ODF_PLAYER, 0xc: ODF_ATTACKABLE | ODF_PLAYER };
      const session = { objectDescFlags: (g) => flagsById[g] };
      const host = new RynthWebHost(session, { noEventTap: true });
      const aAbsent = host.ObjectIsAttackable(0xa);
      const aVendor = host.ObjectIsAttackable(0xb);
      const aMonster = host.ObjectIsAttackable(0xc);
      const hasAbsent = host.HasObjectDescFlags(0xa);
      const hasVendor = host.HasObjectDescFlags(0xb);
      check(
        "T4 fail-open: absent flags -> attackable; present-clear -> not; present-set -> attackable",
        "CombatManager.cs:610 HasObjectIsAttackable guard vs webhost.js ObjectIsAttackable",
        aAbsent === true && aVendor === false && aMonster === true &&
          hasAbsent === false && hasVendor === true,
        `absent=${aAbsent} vendor=${aVendor} monster=${aMonster} hasAbsent=${hasAbsent} hasVendor=${hasVendor}`
      );

      // (d) A host with NO GetObjectDescFlags capability at all must also
      // degrade-open (Contract 0.1 / CombatManager.cs:610 HasObjectIsAttackable=false).
      const bareHost = new RynthWebHost({}, { noEventTap: true });
      const aBare = bareHost.ObjectIsAttackable(0xc);
      check(
        "T4 degrade-open: no desc-flags capability -> attackable (never fail closed)",
        "report 11 Contract 0.1 vs webhost.js ObjectIsAttackable capability-absent",
        aBare === true && bareHost.HasObjectDescFlags(0xc) === false,
        `bareAttackable=${aBare} bareHas=${bareHost.HasObjectDescFlags(0xc)}`
      );
    }

    // ── 7. VTank options through the VT layer's optFn (2026-10-19) ──────
    const VT_DEFAULTS = { TargetLock: false, AttackMinDistance: 0, MonsterDisengageRange: 0, TargetNoProgressTimeoutSec: 0, DoJiggle: false };
    const vtLoop = (host, over = {}) => {
      const loop = mkLoop(host);
      const opts = { ...VT_DEFAULTS, ...over };
      loop.optFn = (k) => opts[k];
      return loop;
    };
    const at = (id, name, d) => ({ id, name, x: 96, y: 96 + d }); // d metres north of the player
    const hex = (g) => (g >>> 0).toString(16);

    // 7a. T3 auto hysteresis: the engaged lock is kept out to MonsterRange + 3
    // m (and still wins the stickiness contest there); without the layer it
    // leaves the scan at 40 m and the alternative re-locks at once.
    {
      const A = 0x10000041, B = 0x10000042;
      const host = makeHost([at(A, "Drudge", 41.5), at(B, "Drudge", 35)]);
      const plain = mkLoop(host);
      plain.locked = A;
      plain.lastSeenLockedAt = NOW;
      frozen(NOW);
      const s0 = plain._selectTarget();
      const vt = vtLoop(host);
      vt.locked = A;
      vt.lastSeenLockedAt = NOW;
      const s1 = vt._selectTarget();
      const scanHasLock = vt._scanTargets().some((t) => t.guid === A);
      check(
        "T3 auto disengage: lock at 41.5 m kept (MonsterRange 40 + 3); literal path re-locks",
        "TargetScoring.cs DisengageDistance :157-158, engaged scan range :266-268",
        s0 === B && s1 === A && scanHasLock,
        `literal=${hex(s0)} vt=${hex(s1)} scanHasLock=${scanHasLock}`
      );
      const lone = makeHost([at(0x10000043, "Drudge", 41.5)]);
      const fresh = vtLoop(lone);
      check(
        "T3: a NEW target still needs MonsterRange (41.5 m is not acquired)",
        "TargetScoring.cs scan: dist > (isEngaged ? max(MonsterRange, disengage) : MonsterRange)",
        fresh._selectTarget() === 0,
        `locked=${hex(fresh.locked)}`
      );
    }

    // 7b. Past the disengage range the lock is dropped at once ("out of
    // range"), not held through the 1.5 s scan grace (which is for a lock
    // gone from the snapshot) — the literal path still holds it.
    {
      const A = 0x10000044;
      const host = makeHost([at(A, "Drudge", 43.5)]);
      const plain = mkLoop(host);
      plain.locked = A;
      plain.lastSeenLockedAt = NOW;
      frozen(NOW + 100);
      const s0 = plain._selectTarget();
      const logs = [];
      const vt = vtLoop(host);
      vt.log = (m) => logs.push(m);
      vt.locked = A;
      vt.lastSeenLockedAt = NOW;
      const s1 = vt._selectTarget();
      check(
        "T3: lock at 43.5 m (> 43) dropped at once as out of range; literal path holds it through the grace",
        "TargetScoring.cs validation: Distance > disengageLimit -> Drop(\"out of range\") (:242)",
        s0 === A && s1 === 0 && logs.some((l) => /out of range/.test(l)),
        `literal=${hex(s0)} vt=${hex(s1)} logs=${JSON.stringify(logs)}`
      );
    }

    // 7c. An explicit MonsterDisengageRange beyond MonsterRange is used as is;
    // one at or below it means auto (+3 m); host.nearbyRangeM caps it.
    {
      const A = 0x10000045;
      const keepAt = (d, over, nearby) => {
        const host = makeHost([at(A, "Drudge", d)]);
        if (nearby !== undefined) host.nearbyRangeM = nearby;
        const loop = vtLoop(host, over);
        loop.locked = A;
        loop.lastSeenLockedAt = NOW;
        frozen(NOW + 100);
        return loop._selectTarget() === A;
      };
      const r = {
        d50at48: keepAt(48, { MonsterDisengageRange: 50 }),
        d50at51: keepAt(51, { MonsterDisengageRange: 50 }),
        d30at42: keepAt(42, { MonsterDisengageRange: 30 }),
        d30at44: keepAt(44, { MonsterDisengageRange: 30 }),
        cap45at44: keepAt(44, { MonsterDisengageRange: 100 }, 45),
        cap45at46: keepAt(46, { MonsterDisengageRange: 100 }, 45),
        cap0at60: keepAt(60, { MonsterDisengageRange: 100 }, 0),
      };
      check(
        "T3: MonsterDisengageRange 50 keeps to 50 m; 30 (≤ MonsterRange) = auto 43 m; capped at host.nearbyRangeM (0 = unlimited)",
        "TargetScoring.cs DisengageDistance; cells.js nearbyRangeM",
        r.d50at48 && !r.d50at51 && r.d30at42 && !r.d30at44 && r.cap45at44 && !r.cap45at46 && r.cap0at60,
        JSON.stringify(r)
      );
    }

    // 7d. AttackMinDistance: nothing nearer is acquired; a lock that closes
    // inside it is left at once (re-lock if anything else qualifies, else drop).
    {
      const X = 0x10000046, Y = 0x10000047;
      const host = makeHost([at(X, "Rat", 3), at(Y, "Rat", 8)]);
      frozen(NOW);
      const off = vtLoop(host)._selectTarget();
      const on = vtLoop(host, { AttackMinDistance: 5 })._selectTarget();
      const relock = vtLoop(host, { AttackMinDistance: 5 });
      relock.locked = X;
      relock.lastSeenLockedAt = NOW;
      const r1 = relock._selectTarget();
      const alone = makeHost([at(X, "Rat", 3)]);
      const drop = vtLoop(alone, { AttackMinDistance: 5 });
      drop.locked = X;
      drop.lastSeenLockedAt = NOW;
      frozen(NOW + 100);
      const r2 = drop._selectTarget();
      check(
        "AttackMinDistance 5: the 3 m rat is never engaged (8 m one is); a lock inside it re-locks / drops at once",
        "VTank AttackMinimumDistance (webac combatPlan.ts candidates: m.dist < min)",
        off === X && on === Y && r1 === Y && r2 === 0,
        `off=${hex(off)} on=${hex(on)} relock=${hex(r1)} alone=${hex(r2)}`
      );
    }

    // 7e. TargetLock: the selected monster is locked over a nearer one and
    // stays locked (no stickiness contest); a new selection moves the lock.
    {
      const N = 0x10000048, S = 0x10000049;
      const host = makeHost([at(N, "Mite", 5), at(S, "Mite", 30)]);
      host.GetSelectedId = () => host.sel;
      host.sel = S;
      frozen(NOW);
      const off = vtLoop(host)._selectTarget();
      const loop = vtLoop(host, { TargetLock: true });
      const first = loop._selectTarget();
      frozen(NOW + 5000);
      const later = loop._selectTarget();
      host.sel = N;
      const moved = loop._selectTarget();
      const plain = mkLoop(host); // no layer: the selection is never read
      const lit = plain._selectTarget();
      check(
        "TargetLock: the selected 30 m mob beats a 5 m one and is kept; reselecting moves the lock; off / no layer = nearest",
        "MOSS CombatTargetSelection (webac combatPlan.ts candidates rule 5)",
        off === N && first === S && later === S && moved === N && lit === N,
        `off=${hex(off)} first=${hex(first)} later=${hex(later)} moved=${hex(moved)} literal=${hex(lit)}`
      );
    }

    // 7f. TargetLock only takes a VALID candidate: beyond MonsterRange, not
    // attackable, recently killed, a player, nothing selected → normal pick.
    {
      const N = 0x1000004a, S = 0x1000004b;
      const pick = (sEnt, sel = S, setup) => {
        const host = makeHost([at(N, "Mite", 5), sEnt]);
        host.GetSelectedId = () => sel;
        const loop = vtLoop(host, { TargetLock: true });
        if (setup) setup(loop, host);
        frozen(NOW);
        return loop._selectTarget();
      };
      const r = {
        far: pick(at(S, "Mite", 45)),
        unattackable: pick({ ...at(S, "Vendor", 20), attackable: false }),
        killed: pick(at(S, "Mite", 20), S, (loop) => loop.recentlyKilled.set(S, NOW - 1000)),
        parked: pick(at(S, "Mite", 20), S, (loop) => loop.unreachable.set(S, NOW + 30_000)),
        none: pick(at(S, "Mite", 20), 0),
        valid: pick(at(S, "Mite", 20)),
      };
      check(
        "TargetLock: an out-of-range / unattackable / killed / blacklisted selection (or none) falls back to the nearest",
        "TargetLock = the selection only when it is a candidate",
        r.far === N && r.unattackable === N && r.killed === N && r.parked === N && r.none === N && r.valid === S,
        JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, hex(v)])))
      );
    }

    // 7g. Priority first, then the selection: a higher-priority candidate
    // outranks it; an equal one does not; P -1 (the planner's ignore) is not a
    // candidate at all.
    {
      const N = 0x1000004c, S = 0x1000004d;
      const run = (verdict) => {
        const host = makeHost([at(N, "Mite", 5), at(S, "Mite", 30)]);
        host.GetSelectedId = () => S;
        const loop = vtLoop(host, { TargetLock: true });
        loop.vt = { scanVerdict: verdict };
        frozen(NOW);
        return loop._selectTarget();
      };
      const higher = run((g) => ({ scoreBias: g === N ? 2000 : 1000 }));
      const equal = run(() => ({ scoreBias: 1000 }));
      const lower = run((g) => ({ scoreBias: g === N ? 0 : 1000 }));
      const ignored = run((g) => (g === S ? { ignore: true } : { scoreBias: 1000 }));
      check(
        "TargetLock: a P+1 monster outranks the selection; equal / lower priority do not; an ignored (P -1) selection is no candidate",
        "MOSS CombatTargetSelection: priority, then TargetLock",
        higher === N && equal === S && lower === S && ignored === N,
        `higher=${hex(higher)} equal=${hex(equal)} lower=${hex(lower)} ignored=${hex(ignored)}`
      );
    }

    // 7h. A one-frame 0 selection read (a rig LOD swap) keeps the selection;
    // a real deselect falls back to normal selection after SELECTION_HOLD_MS.
    {
      const N = 0x1000004e, S = 0x1000004f;
      const host = makeHost([at(N, "Mite", 5), at(S, "Mite", 30)]);
      host.sel = S;
      host.GetSelectedId = () => host.sel;
      const loop = vtLoop(host, { TargetLock: true });
      frozen(NOW);
      const a = loop._selectTarget();
      host.sel = 0;
      frozen(NOW + 100);
      const gap = loop._selectTarget();
      frozen(NOW + 700);
      const after = loop._selectTarget();
      check(
        "TargetLock: a 0 read 100 ms after the selection keeps it (LOD swap); 600 ms of none = normal pick (nearer one steals)",
        "webhost.js selectionClock (LOD respawn re-selects the same guid a frame later)",
        a === S && gap === S && after === N,
        `a=${hex(a)} gap=${hex(gap)} after=${hex(after)}`
      );
    }

    // 7i. netBrain "on" seat: the C# pick drives the lock — except the
    // player's TargetLock selection, which the C# slice cannot see. The C#
    // input carries the disengage range and AttackMinDistance (user-never-attack).
    {
      const N = 0x8000a050, S = 0x8000a051, Z = 0x8000a052; // > 2^31: the int32 round trip
      const host = makeHost([at(N, "Mite", 5), at(S, "Mite", 30), at(Z, "Mite", 2)]);
      host.GetPlayerId = () => 0x50000001;
      host.GetSelectedId = () => S;
      let input = null;
      const brain = {
        scoreTargets: (inp) => {
          input = inp;
          return { SelectedTargetId: N | 0, LockedTargetId: N | 0, Switched: true, TargetLostScanAtMs: -1, Scanned: [{ Id: N | 0, Score: 90 }], Excluded: [] };
        },
      };
      const run = (over) => {
        const loop = vtLoop(host, over);
        loop.attachNetBrain(brain, "on", nbModule, { minIntervalMs: 0 });
        frozen(NOW);
        loop.tick();
        return loop.locked;
      };
      const free = run({ AttackMinDistance: 3 });
      const cfg = input && input.Config;
      const zRow = input && input.Entities.find((e) => (e.Id >>> 0) === Z);
      const nRow = input && input.Entities.find((e) => (e.Id >>> 0) === N);
      const locked = run({ AttackMinDistance: 3, TargetLock: true });
      const plain = mkLoop(host);
      plain.attachNetBrain(brain, "on", nbModule, { minIntervalMs: 0 });
      plain.tick();
      const lit = input && input.Config;
      check(
        "netBrain on: C# drives (N) unless TargetLock holds the selection (S); input carries MonsterDisengageRange 43 + UserNeverAttack < AttackMinDistance; 0.0 without the layer",
        "combat_loop.js _selectTarget on-mode / _nbBuildInput; TargetScoring.cs DisengageDistance / user-never-attack",
        free === N && locked === S && cfg && cfg.MonsterDisengageRange === 43 && zRow && zRow.UserNeverAttack === true &&
          nRow && nRow.UserNeverAttack === false && plain.locked === N && lit && lit.MonsterDisengageRange === 0,
        `free=${hex(free)} locked=${hex(locked)} disengage=${cfg && cfg.MonsterDisengageRange} z=${zRow && zRow.UserNeverAttack} literalDisengage=${lit && lit.MonsterDisengageRange}`
      );
    }

    // 7j. The planner's monster-list verdicts reach the C# seat as the JS scan
    // applies them: ignored (priority −1 / an A-off row with nothing left to
    // cast) = user-never-attack; the P×1000 bias + the JS legacy priority term
    // = a per-creature rule keyed by a unique "#vt{guid8}" name tag, ahead of
    // the name rules. Players and non-creatures are never asked; without a
    // planner the input is exactly the literal one.
    {
      const I = 0x8000a060, P2 = 0x8000a061, P1 = 0x8000a062, Q = 0x8000a063, PLAYER = 0x50000002, CHEST = 0x8000a064;
      const host = makeHost([
        at(I, "Drudge", 5), at(P2, "Mite Scion", 10), at(P1, "Mite", 15), at(Q, "Rat", 20),
        { ...at(CHEST, "Chest", 3), itemType: 512 },
      ]);
      host.GetPlayerId = () => 0x50000001;
      const players = new Set([PLAYER]);
      host.NearbyGuids = () => [I, P2, P1, Q, PLAYER, CHEST];
      host.TryGetObjectPosition = (g) => (g === PLAYER ? { objCellId: LB >>> 0, x: 96, y: 100, z: 0 } : host.byId.get(g) ? { objCellId: LB >>> 0, x: host.byId.get(g).x, y: host.byId.get(g).y, z: 0 } : null);
      host.TryGetObjectName = (g) => (g === PLAYER ? "Someone" : host.byId.get(g)?.name ?? null);
      host.ObjectIsPlayer = (g) => players.has(g);
      let input = null;
      const brain = { scoreTargets: (inp) => ((input = inp), { SelectedTargetId: 0, LockedTargetId: 0, TargetLostScanAtMs: -1, Scanned: [], Excluded: [] }) };
      const asked = [];
      const loop = mkLoop(host);
      loop.priorities = { mite: 3 }; // JS legacy term (3 − 1) × 5 = 10 for both mites
      loop.vt = {
        scanVerdict: (g) => {
          asked.push(g);
          if (g === I) return { ignore: true };
          if (g === Q) throw new Error("planner bug");
          return { scoreBias: g === P2 ? 2000 : 1000 };
        },
      };
      loop.attachNetBrain(brain, "on", nbModule, { minIntervalMs: 0 });
      frozen(NOW);
      loop._selectTarget();
      const row = (g) => input.Entities.find((e) => (e.Id >>> 0) === g);
      const tag = (g) => `#vt{${(g >>> 0).toString(16).padStart(8, "0")}}`;
      const rules = input.Config.MonsterRules;
      const ok =
        row(I).UserNeverAttack === true && row(I).Name === "Drudge" &&
        row(P2).Name === `Mite Scion ${tag(P2)}` && row(P2).UserNeverAttack === false &&
        row(P1).Name === `Mite ${tag(P1)}` && row(Q).Name === `Rat ${tag(Q)}` &&
        row(PLAYER).Name === "Someone" && row(CHEST).Name === "Chest" &&
        JSON.stringify(rules) === JSON.stringify([
          { Name: tag(P2), Priority: 403 }, { Name: tag(P1), Priority: 203 }, { Name: tag(Q), Priority: 1 }, { Name: "mite", Priority: 3 },
        ]) &&
        !asked.includes(PLAYER) && !asked.includes(CHEST);
      check(
        "netBrain on + the VT planner: ignored = UserNeverAttack; P×1000 + legacy term = a tagged per-creature rule ahead of the name rules",
        "combat_loop.js _nbBuildInput vs _scanTargets (scanVerdict ignore / scoreBias); TargetScoring.cs ScoreCandidate FirstOrDefault rule",
        ok,
        JSON.stringify({ rows: input.Entities.map((e) => [hex(e.Id), e.Name, e.UserNeverAttack]), rules, asked: asked.map(hex) })
      );
      // No planner: the literal input (names untagged, the name rules only).
      const plain = mkLoop(host);
      plain.priorities = { mite: 3 };
      plain.attachNetBrain(brain, "on", nbModule, { minIntervalMs: 0 });
      plain._selectTarget();
      check(
        "netBrain on without a planner: the literal input (no tags, name rules only, nothing never-attack)",
        "no-layer path unchanged",
        input.Entities.every((e) => !/#vt\{/.test(e.Name) && e.UserNeverAttack === false) &&
          JSON.stringify(input.Config.MonsterRules) === JSON.stringify([{ Name: "mite", Priority: 3 }]),
        JSON.stringify(input.Config.MonsterRules)
      );
    }
  } finally {
    Date.now = realNow;
  }

  const W = Math.max(...results.map((r) => r.name.length)) + 1;
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(W)} ${r.ok ? "" : `[${r.detail}] `}(${r.cite})`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
