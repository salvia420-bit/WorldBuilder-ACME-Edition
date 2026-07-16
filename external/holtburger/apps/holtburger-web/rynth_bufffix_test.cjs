#!/usr/bin/env node
// rynth_bufffix_test.cjs — direct regression guards for the 10 netwasm-parity
// buff/vitals findings (b5.md, docs/rynth-integration/.../BuffScoring) fixed in
// rynth/buff_loop.js, rynth/vitals.js, rynth/kernel.js. Each scenario asserts
// the C#-correct (or deliberately-safer) NEW behavior; every assertion is
// specific enough that it FAILED under the old shipped code (the old behavior
// is noted per case). Complements the fixture-replay harness
// docs/rynth-integration/netwasm-spike/BuffScoring/parity_check.cjs.
//
// C# authority: /mnt/wbterminal1/ac-refs/rynthsuite/Plugins/
//   RynthCore.Plugin.RynthAi/Combat/BuffManager.cs (cited per case).
//
// Run: node rynth_bufffix_test.cjs   (exits 1 on any FAIL)

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const RYNTH = path.join(__dirname, "rynth");

async function loadEsm(file) {
  const src = fs.readFileSync(path.join(RYNTH, file), "utf8");
  const tmp = path.join(os.tmpdir(), `${file.replace(".js", "")}_bufffix_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    return await import("file://" + tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

// Spell metadata shared by the buff cases: Strength family 101 (tiers 1..7 =
// ids 1011..1017), the Incantation of Strength 1018 (nominal tier 8, lands
// skill-capped as 1016), and Phantom family 200 (single tier 3 = 1083).
const META = {
  1011: [101, 1], 1012: [101, 2], 1013: [101, 3], 1014: [101, 4],
  1015: [101, 5], 1016: [101, 6], 1017: [101, 7], 1018: [101, 8],
  1083: [200, 3],
};

// Mutable fake host. `reg` is the live enchantment wire (rows mutated in-test);
// knownIds is the spell book. Casts are recorded.
function makeBuffHost(opts = {}) {
  const state = { reg: opts.reg || [], mode: opts.mode ?? 8, casts: [] };
  return {
    state,
    IsPlayerReady: () => true,
    GetCurrentCombatMode: () => state.mode,
    GetCastBusyState: () => 0,
    GetBusyState: () => 0,
    CastSpell: (target, id) => state.casts.push({ target, id }),
    s: {
      playerEnchantments: () => state.reg.slice(),
      playerKnownSpells: () => (opts.knownIds || Object.keys(META).map(Number)).slice(),
      getSpellRecord: (id) => {
        const m = META[id >>> 0];
        return m ? { category: m[0], roughLevel: m[1] } : null;
      },
      toggleCombatMode: () => { state.mode = 8; },
      playerStats: () => ({ vitals: [1, 100, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100] }),
    },
  };
}

const wire = (spellId, remainingS, family = META[spellId][0]) => ({
  spellId, spellCategory: family, startTime: 0, duration: remainingS,
});

const results = [];
function check(name, cite, cond, detail) {
  results.push({ name, cite, ok: !!cond, detail: detail || "" });
}

async function main() {
  const { RynthBuffLoop } = await loadEsm("buff_loop.js");
  const { RynthVitals } = await loadEsm("vitals.js");
  const { RynthBotKernel } = await loadEsm("kernel.js");

  const realNow = Date.now;
  const T0 = 5_000_000;
  let nowRef = T0;
  Date.now = () => nowRef;

  // Build a ready loop with ladders resolved and families primed from `reg`.
  const mkLoop = (host, raw, opts = {}) => {
    const loop = new RynthBuffLoop(host, raw, { log: () => {}, ...opts });
    loop.startedAt = T0;
    loop._buildLadders();       // resolve desired -> highest known tier
    loop.registryReady = true;  // skip the B1 login gate for the unit
    loop._refresh();            // prime families from the current wire
    return loop;
  };

  try {
    // ── Finding 1 — B11 parked-family livelock (BuffManager.cs:824-827) ──
    // A parked (can't-land) family must NOT count as "below threshold", else
    // the batch respins the healthy set forever. OLD: _anyBelowThreshold
    // ignored parks -> true (livelock).
    {
      const host = makeBuffHost({ reg: [wire(1017, 3000)] }); // Strength active
      const loop = mkLoop(host, [1017, 1083]);                // + Phantom desired
      // Phantom (fam 200) parked by the B9/B10 valve.
      loop.parkedUntil.set(1083, T0 + 60_000);
      loop._rejectParkedUntil.set(200, T0 + 120_000);
      const below = loop._anyBelowThreshold();
      check(
        "F1 B11: parked family excluded from _anyBelowThreshold (no livelock)",
        "BuffManager.cs:824-827 vs buff_loop.js _anyBelowThreshold",
        below === false,
        `_anyBelowThreshold=${below} want false`
      );
    }

    // ── Finding 2a — live expiry timestamps (BuffManager.cs:1216) ──
    // Remaining must decay in real time WITHOUT a refresh, so the kernel gate
    // can't freeze a stale snapshot above threshold. OLD: remainingS frozen at
    // refresh -> stays "active" forever.
    {
      const host = makeBuffHost({ reg: [wire(1017, 400)] }); // 400s remaining
      const loop = mkLoop(host, [1017]);
      const activeAt0 = loop._isActiveReal(1017); // 400 > 300 -> active
      nowRef = T0 + 150_000;                       // +150s, NO refresh
      const activeAt150 = loop._isActiveReal(1017); // 250 < 300 -> inactive
      nowRef = T0;
      check(
        "F2a live expiry: _isActiveReal decays past threshold without refresh",
        "BuffManager.cs:1216 timer.Expiration vs buff_loop.js live remaining",
        activeAt0 === true && activeAt150 === false,
        `at0=${activeAt0} at150=${activeAt150} want true,false`
      );
    }

    // ── Finding 2b — kernel heartbeat death/dispel recovery (BuffManager.cs:521-531) ──
    // A death silently empties the registry; the unconditional heartbeat must
    // re-sync on the 30s cadence so active drops even when the kernel never
    // routes to Buffing. OLD: no heartbeat() -> death never noticed under the
    // kernel gate.
    {
      const host = makeBuffHost({ reg: [wire(1017, 3000)] });
      const loop = mkLoop(host, [1017]);
      const activeBefore = loop.status.active;
      host.state.reg = []; // <-- death: registry emptied
      nowRef = T0 + 31_000;
      loop.heartbeat();    // kernel drives this every tick, action-independent
      const activeAfter = loop.status.active;
      nowRef = T0;
      check(
        "F2b heartbeat: death (empty registry) re-synced -> active drops",
        "BuffManager.cs:521-531 periodic re-sync vs buff_loop.js heartbeat()",
        typeof loop.heartbeat === "function" && activeBefore === 1 && activeAfter === 0,
        `hasHeartbeat=${typeof loop.heartbeat} before=${activeBefore} after=${activeAfter}`
      );
    }

    // ── Finding 3 — B4 tier-upgrade of an active lower tier (BuffManager.cs:1207-1215) ──
    // Family holds V (tier 5) but VII (tier 7) is desired and the family has
    // been observed landing at 7 -> recast to upgrade regardless of time left.
    // OLD: _isActiveReal checked presence+remaining only -> never upgraded.
    {
      const host = makeBuffHost({ reg: [wire(1015, 3000)] }); // V active, 3000s
      const loop = mkLoop(host, [1017]);                       // want VII
      loop._familyAchievedTier.set(101, 7);                    // seen landing at 7
      loop._refresh();
      const activeLower = loop._isActiveReal(1017); // 5 < 7 -> inactive (upgrade)
      host.state.reg = [wire(1017, 3000)];          // now VII active
      loop._refresh();
      const activeSame = loop._isActiveReal(1017);  // 7 == 7 -> active, no flap
      check(
        "F3 B4: active lower tier upgrade-recasts; equal tier stays active",
        "BuffManager.cs:1207-1215 vs buff_loop.js _isActiveReal tier check",
        activeLower === false && activeSame === true,
        `lower=${activeLower} same=${activeSame} want false,true`
      );
    }

    // ── Finding 4 — B8 confirm by FAMILY not spell id (BuffManager.cs:555-556) ──
    // An Incantation (1018) landing skill-capped as 1016 (same family 101) must
    // confirm the 1018 cast. OLD: confirmed by exact id -> 1018 absent -> phantom
    // no-show + wasted recast.
    {
      const host = makeBuffHost({ reg: [] });
      const loop = mkLoop(host, [1018]);            // desired resolves to 1018
      loop.pending = { spellId: 1018, issuedAt: T0 };
      host.state.reg = [wire(1016, 3000)];          // landed as VI, same family
      nowRef = T0 + 700;                            // past SelfBuffConfirmMs(600)
      loop.tick();
      nowRef = T0;
      check(
        "F4 B8: incantation confirmed by family (landed lower tier), no no-show",
        "BuffManager.cs:555-556 vs buff_loop.js pending confirm",
        loop.pending === null && (loop.noShows.get(1018) || 0) === 0,
        `pending=${loop.pending && loop.pending.spellId} noShows=${loop.noShows.get(1018) || 0}`
      );
    }

    // ── Finding 5 — B9 tier-walk-down on a silent no-show (BuffManager.cs:566-573) ──
    // VII silently never lands; the family must WALK DOWN to the next known tier
    // (I) instead of parking unbuffed. OLD: parked 1017 30min, stayed unbuffed.
    {
      const host = makeBuffHost({ reg: [], knownIds: [1011, 1017] });
      const loop = mkLoop(host, [1011]); // resolves up to highest known = 1017
      check(
        "F5 setup: ladder resolved desired to VII",
        "buff_loop.js _buildLadders",
        loop.desired.length === 1 && loop.desired[0] === 1017,
        `desired=${JSON.stringify(loop.desired)}`
      );
      loop.pending = { spellId: 1017, issuedAt: T0 };
      // registry stays empty (silent). Drive past the give-up window.
      nowRef = T0 + 2600;
      loop.tick();
      nowRef = T0;
      check(
        "F5 B9 tier-walk-down: silent VII -> unresolvable, desired drops to I (not parked)",
        "BuffManager.cs:566-573 vs buff_loop.js tier-walk-down",
        loop._unresolvable.has(1017) &&
          loop.desired.length === 1 && loop.desired[0] === 1011 &&
          !loop.parkedUntil.has(1017),
        `unresolvable1017=${loop._unresolvable.has(1017)} desired=${JSON.stringify(loop.desired)} parked1017=${loop.parkedUntil.has(1017)}`
      );
    }

    // ── Finding 9 — B8×B3 sub-threshold-duration buff (deliberately safer than C#) ──
    // A buff that lands with < RebuffSecondsRemaining(300) must CONFIRM (no false
    // no-show) yet NOT retrigger the batch forever (C# rebatches endlessly). OLD:
    // false no-show -> park; and _anyBelowThreshold true -> rebatch.
    {
      const host = makeBuffHost({ reg: [] });
      const loop = mkLoop(host, [1017]);
      loop.pending = { spellId: 1017, issuedAt: T0 };
      host.state.reg = [wire(1017, 250)]; // lands with only 250s (< 300)
      nowRef = T0 + 700;
      loop.tick();
      const noRebatch = loop._anyBelowThreshold() === false; // held active
      nowRef = T0;
      check(
        "F9 B8xB3: short-duration buff confirms + is held active (no false no-show, no rebatch)",
        "BuffManager.cs:555-556 confirm + buff_loop.js short-duration valve",
        loop.pending === null &&
          (loop.noShows.get(1017) || 0) === 0 &&
          loop._shortDurationFamilies.has(101) &&
          noRebatch,
        `pending=${loop.pending} noShows=${loop.noShows.get(1017) || 0} short=${loop._shortDurationFamilies.has(101)} anyBelow=${!noRebatch}`
      );
    }

    // ── Finding 10 — B2 last-wins quirk: JS keeps LATER expiry (CONFIRMED no-change) ──
    // Two same-family wire rows (VII/3500 and V/400): JS deliberately keeps the
    // longer-remaining VII (C# keeps the last row, :1374). Confirms the JS choice.
    {
      const host = makeBuffHost({ reg: [wire(1017, 3500), wire(1015, 400)] });
      const loop = mkLoop(host, [1017]);
      const entry = loop.families.get(101);
      check(
        "F10 B2: same-family rows keep the later-expiry entry (JS-defensible)",
        "BuffManager.cs:1374 (C# last-wins) vs buff_loop.js max-expiry",
        entry && entry.spellId === 1017,
        `kept spellId=${entry && entry.spellId} want 1017`
      );
    }

    // ── Finding 6 — B16 vital order: mana BEFORE stamina (BuffManager.cs:759-760) ──
    // In combat with mana 20 (<40) AND stam 25 (<30, >15): recharge MANA first.
    // OLD: stamina checked first -> Revitalize.
    {
      const host = {
        IsPlayerReady: () => true,
        s: { playerKnownSpells: () => [9001, 9002, 9003, 9004] },
      };
      const vit = new RynthVitals(host, {
        log: () => {},
        spells: { stamToHealth: 9001, healSelf: 9002, stamToMana: 9003, revitalize: 9004 },
      });
      const action = vit._decide({ hp: 100, stam: 25, mana: 20 }, true);
      check(
        "F6 B16: mana recharge chosen before stamina when both low",
        "BuffManager.cs:759-760 vs vitals.js _decide order",
        action && action.spell === 9003 && action.reason.startsWith("getmana"),
        `spell=${action && action.spell} reason=${action && action.reason} want 9003 getmana`
      );
    }

    // ── Finding 7 — B15 boundary: HP == 30 is emergency (BuffManager.cs:733 `<= 30`) ──
    // hp exactly 30, stam 50, idle: emergency Stamina-to-Health. OLD: hp<30 ->
    // fell to the idle top-off arm -> Heal Self (wrong spell at the boundary).
    {
      const host = {
        IsPlayerReady: () => true,
        s: { playerKnownSpells: () => [9001, 9002, 9003, 9004] },
      };
      const vit = new RynthVitals(host, {
        log: () => {},
        spells: { stamToHealth: 9001, healSelf: 9002, stamToMana: 9003, revitalize: 9004 },
      });
      const action = vit._decide({ hp: 30, stam: 50, mana: 100 }, false);
      check(
        "F7 B15: hp==30 triggers emergency (inclusive <=), not idle heal",
        "BuffManager.cs:733 `<= 30` vs vitals.js emergency bound",
        action && action.spell === 9001 && action.reason.startsWith("EMERGENCY"),
        `spell=${action && action.spell} reason=${action && action.reason} want 9001 EMERGENCY`
      );
    }

    // ── Finding 8 — kernel vitals-first is the safer behavior (CONFIRMED no-change) ──
    // A dying character must heal even while a buff cast is pending; the kernel
    // runs vitals AHEAD of the buff pin (C# blocks vitals behind the pending
    // hold, BuffManager.cs:599). Guard against a regression that reorders it.
    {
      let buffTicked = false;
      const combat = { locked: 0, _scanTargets: () => [] };
      const loot = { state: "SCAN", _findCorpse: () => null };
      const buff = { pending: { spellId: 1017 }, tick: () => { buffTicked = true; }, heartbeat: () => {}, status: { ready: true, active: 1, desired: 1, pending: 1017 } };
      let vitalsRan = false;
      const vitals = { step: () => { vitalsRan = true; return true; }, status: {} };
      const host = { IsPlayerReady: () => true, StopStick: () => {} };
      const kernel = new RynthBotKernel(host, { combat, buff, loot, vitals }, { log: () => {} });
      kernel.tick();
      check(
        "F8 kernel: vitals preempt a pending buff (dying heals immediately)",
        "BuffManager.cs:599 (C# blocks) vs kernel.js vitals-first — do not regress",
        vitalsRan === true && buffTicked === false && kernel.action === "Vitals",
        `vitalsRan=${vitalsRan} buffTicked=${buffTicked} action=${kernel.action}`
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
