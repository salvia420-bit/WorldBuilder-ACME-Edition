#!/usr/bin/env node
// parity_check.cjs — replay fixtures.json (C# TargetScoring expectations)
// against the SHIPPED JS combat brain: apps/holtburger-web/rynth/combat_loop.js.
//
// For each scenario it builds a mock RynthWebHost (mirroring webhost.js's
// contracts, including its fail-closed ObjectIsAttackable, webhost.js:346-349),
// instantiates RynthCombatLoop, seeds the lock state, and runs _selectTarget()
// under a frozen Date.now. Because combat_loop's dead-target handling lives in
// tick() (not _selectTarget), the harness also emulates that one check
// (combat_loop.js:308-321) and, when it fires, runs a second _selectTarget to
// capture the next-tick re-acquire ("agree-after-1-tick").
//
// Divergences are FINDINGS, not failures — exit code is 0 unless the harness
// itself breaks. Run:  node parity_check.cjs [path/to/fixtures.json]

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const HERE = __dirname;
const FIXTURES = process.argv[2] || path.join(HERE, "fixtures.json");
const COMBAT_LOOP = path.join(HERE, "../../../../apps/holtburger-web/rynth/combat_loop.js");

function headingRad(p) {
  // Same math as CombatManager.cs:565-566 / TargetScoring.Angle, in radians.
  const physYawDeg = (2 * Math.atan2(p.QZ, p.QW) * 180) / Math.PI;
  const deg = (((-physYawDeg) % 360) + 720) % 360;
  return (deg * Math.PI) / 180;
}

function makeHost(input) {
  const byId = new Map(input.Entities.map((e) => [e.Id, e]));
  const p = input.Player;
  return {
    IsPlayerReady: () => true,
    TryGetPlayerPose: () => ({
      objCellId: p.ObjCellId >>> 0,
      x: p.X, y: p.Y, z: p.Z,
      heading: p.HasPose ? headingRad(p) : null,
    }),
    NearbyGuids: () => input.Entities.map((e) => e.Id),
    ObjectIsPlayer: (g) => !!byId.get(g)?.IsPlayer,
    TryGetObjectIntProperty: (g, stype) =>
      stype === 1 ? byId.get(g)?.ItemType : undefined,
    // webhost.js:346-349 — fail CLOSED when desc flags are unknown.
    ObjectIsAttackable: (g) => {
      const e = byId.get(g);
      if (!e) return false;
      return e.AttackableUnknown ? false : !!e.Attackable;
    },
    TryGetTargetHealthFraction: (g) => byId.get(g)?.HealthRatio ?? -1,
    TryGetObjectPosition: (g) => {
      const e = byId.get(g);
      if (!e || !e.HasPosition) return null;
      return { objCellId: e.ObjCellId >>> 0, x: e.X, y: e.Y, z: e.Z };
    },
    TryGetObjectName: (g) => byId.get(g)?.Name ?? null,
    has: () => false,
  };
}

async function main() {
  // combat_loop.js is ESM (`export class`) but carries a .js extension with no
  // "type":"module" package.json above it — copy to a temp .mjs so Node's
  // loader classifies it correctly. The bytes tested are the repo file's.
  const src = fs.readFileSync(COMBAT_LOOP, "utf8");
  const tmp = path.join(os.tmpdir(), `combat_loop_parity_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  let RynthCombatLoop;
  try {
    ({ RynthCombatLoop } = await import("file://" + tmp));
  } finally {
    fs.unlinkSync(tmp);
  }

  const fx = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
  const realNow = Date.now;
  const rows = [];
  const byRule = new Map();

  for (const sc of fx.scenarios) {
    const input = sc.input;
    const exp = sc.expected;
    const host = makeHost(input);

    // priorities: C# MonsterRules -> the JS opts.priorities dict (lowercased
    // name-substring keys; "Default" rules have no JS counterpart).
    const priorities = {};
    for (const r of input.Config.MonsterRules || []) {
      if (r.Name.toLowerCase() === "default") continue;
      priorities[r.Name.toLowerCase()] = r.Priority;
    }

    const loop = new RynthCombatLoop(host, { log: () => {}, priorities });
    const nowMs = input.NowMs;
    loop.locked = input.Lock.LockedTargetId || 0;
    loop.lockedScore = -1;
    loop.lastSeenLockedAt =
      input.Lock.TargetLostScanAtMs >= 0 ? input.Lock.TargetLostScanAtMs : nowMs;
    for (const e of input.Entities)
      if (e.KilledMsAgo >= 0) loop.recentlyKilled.set(e.Id, nowMs - e.KilledMsAgo);

    Date.now = () => nowMs;
    let jsScan, jsTick1, jsTick2 = null, killDropped = false;
    try {
      jsScan = loop._scanTargets().map((t) => ({ id: t.guid, score: t.score, dist: t.dist }));
      jsTick1 = loop._selectTarget() || 0;
      // tick()-level kill/disappearance check (combat_loop.js:308-321).
      if (jsTick1) {
        const hf = host.TryGetTargetHealthFraction(jsTick1);
        // hp=0 is the SOLE kill confirm — mirror combat_loop.js:325-331 (a
        // positionless lock is a transient world-filter miss, not a kill).
        // The old `!pos ||` here produced 2 phantom-kill DIVERGE artifacts.
        if (hf === 0) {
          killDropped = true;
          loop.recentlyKilled.set(jsTick1, nowMs);
          loop.locked = 0;
          loop.lockedScore = -1;
          jsTick2 = loop._selectTarget() || 0;
        }
      }
    } finally {
      Date.now = realNow;
    }

    const jsFinal = killDropped ? jsTick2 : jsTick1;
    const expSel = exp.SelectedTargetId;
    let verdict;
    if (expSel === jsFinal) verdict = killDropped ? "agree-1tick-lag" : "agree";
    else verdict = "DIVERGE";

    // Filter-set comparison: which ids each side considered at all.
    const csIds = new Set(exp.Scanned.map((s) => s.Id));
    const jsIds = new Set(jsScan.map((s) => s.id));
    const csOnly = [...csIds].filter((i) => !jsIds.has(i));
    const jsOnly = [...jsIds].filter((i) => !csIds.has(i));
    const filterDelta =
      csOnly.length || jsOnly.length
        ? `filter(csOnly=[${csOnly.map((i) => i.toString(16))}] jsOnly=[${jsOnly.map((i) => i.toString(16))}])`
        : "filters-agree";

    rows.push({
      name: sc.name,
      rules: sc.rules.join(","),
      verdict,
      cs: expSel ? expSel.toString(16) : "-",
      js: jsFinal ? jsFinal.toString(16) : "-",
      detail: filterDelta + (exp.DropReason ? ` csDrop='${exp.DropReason}'` : ""),
    });
    for (const r of sc.rules) {
      const b = byRule.get(r) || { agree: 0, lag: 0, diverge: 0 };
      if (verdict === "agree") b.agree++;
      else if (verdict === "agree-1tick-lag") b.lag++;
      else b.diverge++;
      byRule.set(r, b);
    }
  }

  const W = Math.max(...rows.map((r) => r.name.length)) + 1;
  for (const r of rows)
    console.log(
      `${r.verdict.padEnd(15)} ${r.name.padEnd(W)} cs=${r.cs.padEnd(9)} js=${r.js.padEnd(9)} [${r.rules}] ${r.detail}`
    );

  const agree = rows.filter((r) => r.verdict === "agree").length;
  const lag = rows.filter((r) => r.verdict === "agree-1tick-lag").length;
  const div = rows.filter((r) => r.verdict === "DIVERGE").length;
  console.log(`\nTOTAL: ${rows.length} scenarios — agree=${agree} agree-1tick-lag=${lag} DIVERGE=${div}`);
  console.log("per-rule:", [...byRule.entries()]
    .map(([r, b]) => `${r}: ${b.agree}+${b.lag}lag/${b.diverge}x`).join("  "));
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
