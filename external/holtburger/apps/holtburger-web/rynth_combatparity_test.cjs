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
