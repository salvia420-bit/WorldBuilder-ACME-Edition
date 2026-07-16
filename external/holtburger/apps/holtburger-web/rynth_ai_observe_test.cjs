#!/usr/bin/env node
// rynth_ai_observe_test.cjs — unit tests for rynth/ai/observe.js
// (buildObservation: the AI director's compact prompt block). No infra, no
// network — a hand-built mock bot (real combat/vitals loops over a mock host,
// plain objects for the rest). See rynth/ai/SPEC.md §observe.
//
// Run: node rynth_ai_observe_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const mod = (p) => import(pathToFileURL(path.join(__dirname, ...p)).href);
  const ob = await mod(["rynth", "ai", "observe.js"]);
  const cl = await mod(["rynth", "combat_loop.js"]);
  const vt = await mod(["rynth", "vitals.js"]);

  const NOW = 1_800_000_000_000; // fixed clock — determinism asserted below

  // ── the known-coords fixture: Holtburg landblock 0xA9B4, local (60,100,12).
  // Expected /loc degrees via the router/sidecar math the module must reuse:
  // world = lbByte*192 + local (router.js:45-47 worldXY), then
  // deg = (world / 24 - 1019.5) / 10 (rynthnav-sidecar/DetourRouter.cs:131,
  // NS from world-Y / EW from world-X per DetourRouter.cs:244-245).
  const POSE = { objCellId: 0xa9b40015, x: 60, y: 100, z: 12, heading: null };
  const expEw = ((0xa9 * 192 + 60) / 24 - 1019.5) / 10; // 33.5
  const expNs = ((0xb4 * 192 + 100) / 24 - 1019.5) / 10; // 42.4666…

  const M = (i) => 0x80000a00 + i; // monster guids (>2^31, like live ACE)
  const ents = {
    [M(1)]: { name: "drudge skulker", x: 66, y: 108, z: 12, hf: 0.45, type: 16, attackable: true },
    [M(2)]: { name: "rabid rat", x: 72, y: 100, z: 12, hf: -1, type: 16, attackable: true },
    [M(3)]: { name: "town crier", x: 62, y: 100, z: 12, hf: -1, type: 16, attackable: false }, // NPC — must be filtered
    0x70000001: { name: "Corpse of Ilserv", x: 61, y: 101, z: 12, hf: 0, type: 51, attackable: false, wcid: 21 },
    0x50000123: { name: "Some Player", x: 63, y: 100, z: 12, hf: -1, type: 16, attackable: true }, // player guid range — filtered
  };

  function makeHost(overrides = {}) {
    return {
      IsPlayerReady: () => true,
      TryGetPlayerPose: () => POSE,
      NearbyGuids: () => Object.keys(ents).map(Number),
      ObjectIsPlayer: () => false,
      TryGetObjectIntProperty: (g, k) => (k === 1 ? ents[g]?.type : undefined),
      TryGetObjectPosition: (g) =>
        ents[g] ? { objCellId: 0xa9b40015, x: ents[g].x, y: ents[g].y, z: ents[g].z } : null,
      TryGetObjectName: (g) => ents[g]?.name ?? null,
      TryGetTargetHealthFraction: (g) => ents[g]?.hf ?? -1,
      ObjectIsAttackable: (g) => ents[g]?.attackable ?? false,
      TryGetObjectWcid: (g) => ents[g]?.wcid ?? 0,
      has: () => false,
      onTick: () => {},
      onEvent: () => {},
      s: {
        // flat [type, cur, base, buffedMax] per vitals.js _fractions
        playerStats: () => ({ vitals: [1, 85, 100, 100, 3, 70, 100, 100, 5, 61, 100, 100] }),
        playerKnownSpells: () => [],
      },
      ...overrides,
    };
  }

  function makeBot() {
    const host = makeHost();
    const combat = new cl.RynthCombatLoop(host, { log: () => {}, priorities: { olthoi: 10 } });
    combat.locked = M(1);
    combat.kills = 12;
    const vitals = new vt.RynthVitals(host, { log: () => {} });
    return {
      host,
      combat,
      vitals,
      buff: {
        startedAt: NOW - (83 * 60_000 + 20_000), // kernel.js:33 stamps this on start
        status: { ready: true, desired: 6, active: 5, parked: ["fam-12"], pending: 0 },
      },
      loot: { minValue: 500, lootedCount: 7 },
      kernel: { running: true, action: "Combat", status: { action: "Combat", kills: 12, looted: 7 } },
      router: { status: { state: "WALK", leg: 1, legs: 5, walked: 1 } },
      globalRouter: { busy: true },
    };
  }

  // ── full-data render ────────────────────────────────────────────────────
  const diag = { netbrain: { summary: () => "netbrain mode=shadow rynth-netbrain-1.2.3\ncombat: 1/2 agree" } };
  const spend = { calls: 3, promptTokens: 1200, completionTokens: 400, errors: 0 };
  const journalTail = "[t-300] plan: none\n[t-0] note: hunting drudges";
  const bot = makeBot();
  const { text, data } = ob.buildObservation(bot, { journalTail, now: NOW, diag, spend });

  check("returns text+data", typeof text === "string" && text.length > 0 && data && typeof data === "object");
  check("uptime rendered", text.includes("uptime: 1h23m"), text.split("\n")[0]);
  check("kernel line", text.includes("kernel: running action=Combat kills=12 looted=7"));
  check("pos landblock hex", text.includes("0xa9b40015"));
  check("pos xyz", text.includes("xyz=(60.0,100.0,12.0)"));
  // /loc degrees vs the router math (and the known Holtburg-area literals —
  // catches a formula-echo bug where module+test share the same wrong math).
  check("data ns matches router math", Math.abs(data.position.ns - expNs) < 1e-9,
    `got ${data.position.ns} want ${expNs}`);
  check("data ew matches router math", Math.abs(data.position.ew - expEw) < 1e-9,
    `got ${data.position.ew} want ${expEw}`);
  check("loc literal 42.47N", text.includes("42.47N"));
  check("loc literal 33.50E", text.includes("33.50E"));
  check("loc sanity (Holtburg ~42.1N 33.6E)",
    data.position.ns > 41 && data.position.ns < 44 && data.position.ew > 32 && data.position.ew < 35);
  check("vitals line", text.includes("vitals: hp=85% stam=70% mana=61%"));
  check("buffs line", text.includes("buffs: active=5/6 parked=1 pending=0 ready=y"));
  // lock M(1): same-lb distance hypot(6,8,0)=10.0
  check("lock line", text.includes(`lock: 0x${M(1).toString(16)} "drudge skulker" hp=45% d=10.0m`),
    text.split("\n").find((l) => l.startsWith("lock:")));
  check("threats header", text.includes("threats (2/2):"));
  check("threat lines", text.includes("- drudge skulker d=10.0 hp=45%") && text.includes("- rabid rat d=12.0 hp=?"));
  check("threats exclude NPC/player/corpse",
    !text.includes("town crier") && !text.includes("Some Player") && !text.includes("- Corpse"));
  check("data threats sorted best-first", data.threats.length === 2 && data.threats[0].name === "drudge skulker");
  check("corpse count", text.includes("corpses: 1"));
  check("router+goto line", text.includes("router: WALK leg=2/5 walked=1 | goto: active"));
  check("loot/priorities line", text.includes("loot_min: 500 | priorities: olthoi:10"));
  check("netbrain first line only",
    text.includes("netbrain: netbrain mode=shadow rynth-netbrain-1.2.3") && !text.includes("1/2 agree"));
  check("ai spend line", text.includes("ai_spend: calls=3 prompt=1200 completion=400 errors=0"));
  check("journal tail included", text.includes("journal:\n" + journalTail));

  // ── S/W hemisphere rendering ────────────────────────────────────────────
  {
    const pose = { objCellId: 0x12340005, x: 10, y: 20, z: 0 };
    const r = ob.buildObservation({ host: makeHost({ TryGetPlayerPose: () => pose }) }, { now: NOW });
    const wantNs = ((0x34 * 192 + 20) / 24 - 1019.5) / 10; // negative -> S
    const wantEw = ((0x12 * 192 + 10) / 24 - 1019.5) / 10; // negative -> W
    check("southern/western degrees", r.data.position.ns === wantNs && r.data.position.ew === wantEw,
      `ns=${r.data.position.ns} ew=${r.data.position.ew}`);
    check("S/W suffixes rendered",
      r.text.includes(`${Math.abs(wantNs).toFixed(2)}S`) && r.text.includes(`${Math.abs(wantEw).toFixed(2)}W`),
      r.text.split("\n").find((l) => l.startsWith("pos:")));
  }

  // ── every subsystem missing -> "n/a" lines, never throws ───────────────
  {
    const r = ob.buildObservation({}, { now: NOW });
    for (const line of [
      "uptime: n/a", "kernel: n/a", "pos: n/a", "vitals: n/a", "buffs: n/a",
      "lock: n/a", "threats: n/a", "corpses: n/a", "router: n/a", "goto: n/a",
      "loot_min: n/a", "priorities: n/a", "netbrain: n/a", "journal: (none)",
    ]) {
      check(`empty bot: ${line}`, r.text.includes(line));
    }
    check("empty bot: no spend line when not given", !r.text.includes("ai_spend"));
  }

  // combat present but nothing locked -> "none", not n/a
  {
    const bot2 = makeBot();
    bot2.combat.locked = 0;
    const r = ob.buildObservation(bot2, { now: NOW });
    check("unlocked renders 'lock: none'", r.text.includes("lock: none"));
  }

  // hostile bot: EVERY property access throws -> still a full n/a render
  {
    const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
    let r = null, threw = false;
    try { r = ob.buildObservation(hostile, { now: NOW }); } catch (_) { threw = true; }
    check("hostile bot never throws", !threw && r && r.text.includes("uptime: n/a") && r.text.includes("threats: n/a"));
  }

  // window.__diag fallback (no opts.diag)
  {
    globalThis.window = { __diag: { netbrain: { summary: () => "winline first\nsecond" } } };
    try {
      const r = ob.buildObservation({}, { now: NOW });
      check("window.__diag fallback", r.text.includes("netbrain: winline first") && !r.text.includes("second"));
    } finally {
      delete globalThis.window;
    }
  }

  // ── maxChars: threats truncate first, then the hard cap ────────────────
  {
    const many = {};
    for (let i = 1; i <= 12; i++) {
      many[M(i)] = { name: `verbosely named test monstrosity number ${i}`, x: 60 + i, y: 100, z: 12, hf: 0.5, type: 16, attackable: true };
    }
    const host = makeHost({
      NearbyGuids: () => Object.keys(many).map(Number),
      TryGetObjectIntProperty: (g, k) => (k === 1 && many[g] ? many[g].type : undefined),
      TryGetObjectPosition: (g) => (many[g] ? { objCellId: 0xa9b40015, x: many[g].x, y: many[g].y, z: many[g].z } : null),
      TryGetObjectName: (g) => many[g]?.name ?? null,
      TryGetTargetHealthFraction: (g) => many[g]?.hf ?? -1,
      ObjectIsAttackable: () => true,
      TryGetObjectWcid: () => 0,
    });
    const combat = new cl.RynthCombatLoop(host, { log: () => {} });
    const bigBot = { host, combat };
    const jt = "journal line one\njournal line two";

    const full = ob.buildObservation(bigBot, { journalTail: jt, now: NOW });
    const countThreatLines = (t) => (t.match(/^- /gm) || []).length;
    check("threats capped at top-8", full.data.threats.length === 8 && countThreatLines(full.text) === 8,
      `data=${full.data.threats.length} lines=${countThreatLines(full.text)}`);

    const cap = full.text.length - 60; // forces dropping threat lines, nothing else
    const trunc = ob.buildObservation(bigBot, { journalTail: jt, now: NOW, maxChars: cap });
    check("maxChars respected", trunc.text.length <= cap, `len=${trunc.text.length} cap=${cap}`);
    check("threats dropped first", countThreatLines(trunc.text) < 8 && trunc.text.includes("journal:\n" + jt),
      `lines=${countThreatLines(trunc.text)}`);
    check("data untouched by truncation", trunc.data.threats.length === 8);

    const tiny = ob.buildObservation(bigBot, { journalTail: jt, now: NOW, maxChars: 40 });
    check("hard cap slices", tiny.text.length <= 40, `len=${tiny.text.length}`);
  }

  // ── determinism: same (bot, now) -> byte-identical text + data ─────────
  {
    const b1 = makeBot();
    const a = ob.buildObservation(b1, { journalTail, now: NOW, diag, spend });
    const b = ob.buildObservation(b1, { journalTail, now: NOW, diag, spend });
    check("deterministic text", a.text === b.text);
    check("deterministic data", JSON.stringify(a.data) === JSON.stringify(b.data));
  }

  // defaults path (no opts) must not throw
  {
    let ok = true;
    try { ob.buildObservation(makeBot()); } catch (_) { ok = false; }
    check("default opts do not throw", ok);
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
