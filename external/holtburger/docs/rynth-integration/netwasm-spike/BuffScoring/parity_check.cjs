#!/usr/bin/env node
// parity_check.cjs — replay fixtures.json (C# BuffScheduling expectations)
// against the SHIPPED JS buff brain: apps/holtburger-web/rynth/buff_loop.js
// (+ vitals.js for B15/B16), composed in kernel.js order (vitals first,
// kernel.js:61-76; optional _buffNeeded gate, kernel.js:55-59, for scenarios
// flagged kernelGate).
//
// For each scenario it rebuilds the SAME tick schedule + landing simulation
// the C# fixture runner used (keep the sim rules in sync with
// fixtures/FixtureRunner.cs), drives RynthBuffLoop.tick()/RynthVitals.step()
// under a frozen Date.now, records cast/mode events, and compares the C# vs
// JS event SEQUENCES (kind:id order), with timing deltas classified:
//   agree          — same sequence, all matched events within 1.2s
//   agree-latency  — same sequence, some event >=1.2s apart (cadence finding)
//   DIVERGE        — different casts/order/count (a B-rule finding)
//
// Divergences are FINDINGS, not failures. Exit is nonzero only if the harness
// breaks or a scenario NOT flagged expectDiverge comes out DIVERGE (i.e. the
// authored expectation itself is wrong and needs analysis).
//
// Run:  node parity_check.cjs [path/to/fixtures.json]

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const HERE = __dirname;
const FIXTURES = process.argv[2] || path.join(HERE, "fixtures.json");
const RYNTH = path.join(HERE, "../../../../apps/holtburger-web/rynth");

const LATENCY_MS = 1200;

// duration by landed tier — GetCustomSpellDuration (BuffManager.cs:1302-1311)
function durationS(tier) {
  if (tier === 6) return 2700;
  if (tier === 7) return 3600;
  if (tier === 8) return 5400;
  return 1800;
}

async function loadModules() {
  // ESM files with .js extension and no "type":"module" package.json above
  // them — copy to temp .mjs so Node's loader classifies them correctly.
  // The bytes tested are the repo files'.
  const mods = {};
  for (const [key, file] of [["buff", "buff_loop.js"], ["vitals", "vitals.js"]]) {
    const src = fs.readFileSync(path.join(RYNTH, file), "utf8");
    const tmp = path.join(os.tmpdir(), `${file.replace(".js", "")}_parity_${process.pid}.mjs`);
    fs.writeFileSync(tmp, src);
    try {
      mods[key] = await import("file://" + tmp);
    } finally {
      fs.unlinkSync(tmp);
    }
  }
  return { RynthBuffLoop: mods.buff.RynthBuffLoop, RynthVitals: mods.vitals.RynthVitals };
}

function runScenario(sc, T0, landsMs, RynthBuffLoop, RynthVitals) {
  // ── mutable sim state ──
  let hp = sc.vitals.hp, stam = sc.vitals.stam, mana = sc.vitals.mana;
  const landed = []; // {landAt(abs), id, family, durS, k}
  let castCounter = 0;
  const casts = []; // {t(offset), kind, id}
  const logs = [];

  const clearAtAbs = sc.clearAtMs != null ? T0 + sc.clearAtMs : null;
  let nowAbs = T0;

  function modeAt(t) {
    if (sc.modeAtMs != null && t >= T0 + sc.modeAtMs) return 8;
    return sc.inMagicModeInitial ? 8 : 1;
  }

  // registry wire entries at nowAbs — mirror FixtureRunner.cs registryView():
  // initial entries (appear/remove/clear windows, shadowed by same-family
  // landings), then landings (newest per family). Wire form start=k,
  // duration=R0+k so buff_loop's receivedAt bookkeeping (buff_loop.js:243-261)
  // yields remaining=R0 at first sight, decaying thereafter; a recast gets a
  // new k -> re-stamps.
  function registryWire() {
    const t = nowAbs;
    const out = [];
    for (const e of sc.initialRegistry) {
      if (t < T0 + e.appearsAtMs) continue;
      if (e.removedAtMs != null && t >= T0 + e.removedAtMs) continue;
      if (clearAtAbs != null && t >= clearAtAbs) continue;
      if (landed.some((l) => l.family === e.family && t >= l.landAt)) continue;
      out.push({
        spellId: e.spellId, spellCategory: e.family,
        startTime: 0,
        duration: e.permanent ? -1 : e.remainingS,
      });
    }
    const byFam = new Map();
    for (const l of landed) {
      if (t < l.landAt) continue;
      if (clearAtAbs != null && l.landAt < clearAtAbs && t >= clearAtAbs) continue;
      const prev = byFam.get(l.family);
      if (!prev || l.landAt > prev.landAt) byFam.set(l.family, l);
    }
    for (const l of byFam.values())
      out.push({ spellId: l.id, spellCategory: l.family, startTime: l.k, duration: l.durS + l.k });
    return out;
  }

  let caster = "buff";
  const host = {
    IsPlayerReady: () => true,
    GetCurrentCombatMode: () => modeAt(nowAbs),
    GetCastBusyState: () => (sc.canCastNow ? 0 : 1),
    GetBusyState: () => sc.busyCount,
    CastSpell: (_target, id) => {
      casts.push({ t: nowAbs - T0, kind: caster === "vital" ? "vital" : "buff", id });
      if (caster === "buff") {
        castCounter++;
        if (!sc.silent.includes(id)) {
          const la = sc.landsAs[String(id)] || null;
          const lid = la ? la.id : id;
          const lfam = la ? la.family : (sc.spellMeta[String(id)] ? sc.spellMeta[String(id)][0] : 0);
          const tier = sc.spellMeta[String(lid)] ? sc.spellMeta[String(lid)][1] : 1;
          const durS = sc.landDurationOverrideS != null ? sc.landDurationOverrideS : durationS(tier);
          landed.push({ landAt: nowAbs + landsMs, id: lid, family: lfam, durS, k: castCounter });
        }
      }
      // vital casts are instant effects — never enter the registry
    },
    s: {
      playerEnchantments: () => registryWire(),
      playerKnownSpells: () => sc.knownIds.slice(),
      getSpellRecord: (id) => {
        const m = sc.spellMeta[String(id >>> 0)];
        return m ? { category: m[0], roughLevel: m[1] } : null;
      },
      toggleCombatMode: () => {
        // server-delayed flip: mode changes only via modeAtMs (symmetric with
        // the C# InMagicMode input); the attempt itself is the observable.
        casts.push({ t: nowAbs - T0, kind: "mode", id: 0 });
      },
      playerStats: () => ({ vitals: [1, hp, 0, 100, 3, stam, 0, 100, 5, mana, 0, 100] }),
    },
  };

  // rawDesired: the caller names a buff by ANY family spell (lowest known
  // tier here); B4 ladders upgrade it (buff_loop.js:66-74).
  const rawDesired = sc.desired.map((d) => {
    const k = d.ladder.find((c) => c.known) || d.ladder[0];
    return k.id;
  });

  const loop = new RynthBuffLoop(host, rawDesired, { log: (m) => logs.push(`[buff] ${m}`) });
  loop.startedAt = T0;
  const vitals = new RynthVitals(host, {
    log: (m) => logs.push(`[vitals] ${m}`),
    spells: {
      healSelf: sc.vitals.healSelfId,
      stamToHealth: sc.vitals.stamToHealthId,
      stamToMana: sc.vitals.stamToManaId,
      revitalize: sc.vitals.revitalizeId,
    },
    thresholds: {
      healAtCombat: sc.config.healAt, getManaAtCombat: sc.config.getManaAt,
      restamAtCombat: sc.config.restamAt, topOffHp: sc.config.topOffHp,
      topOffStam: sc.config.topOffStam, topOffMana: sc.config.topOffMana,
    },
  });

  // kernel.js:55-59 — the _buffNeeded gate (kernelGate scenarios only)
  function buffNeeded() {
    const st = loop.status;
    return !st.ready || st.active < st.desired || st.pending !== 0;
  }

  const realNow = Date.now;
  try {
    for (const off of sc.tickTimes) {
      nowAbs = T0 + off;
      for (const ev of sc.vitalsEvents) {
        if (T0 + ev.atMs <= nowAbs) {
          if (ev.hp != null) hp = ev.hp;
          if (ev.stam != null) stam = ev.stam;
          if (ev.mana != null) mana = ev.mana;
        }
      }
      Date.now = () => nowAbs;
      // kernel.js order, combat/loot absent: UNCONDITIONAL buff heartbeat
      // (finding 2, kernel.js tick() top) -> vitals first -> then buffs.
      if (loop.heartbeat) loop.heartbeat();
      caster = "vital";
      const consumed = vitals.step(sc.vitals.inCombat);
      if (!consumed) {
        if (!sc.kernelGate || buffNeeded()) {
          caster = "buff";
          loop.tick();
        }
      }
    }
  } finally {
    Date.now = realNow;
  }
  return { casts, logs };
}

function verdictFor(csCasts, jsCasts) {
  const seq = (cs) => cs.filter((c) => c.kind !== "mode");
  const a = seq(csCasts), b = seq(jsCasts);
  const key = (c) => `${c.kind}:${c.id}`;
  if (a.length === b.length && a.every((c, i) => key(c) === key(b[i]))) {
    let maxDelta = 0;
    for (let i = 0; i < a.length; i++) maxDelta = Math.max(maxDelta, Math.abs(a[i].t - b[i].t));
    return { verdict: maxDelta >= LATENCY_MS ? "agree-latency" : "agree", detail: `maxΔ=${maxDelta}ms over ${a.length} casts` };
  }
  const fmt = (cs) => cs.map((c) => `${c.kind}:${c.id}@${c.t / 1000}s`).join(" ");
  return { verdict: "DIVERGE", detail: `cs[${a.length}]: ${fmt(a) || "-"}  ||  js[${b.length}]: ${fmt(b) || "-"}` };
}

async function main() {
  const { RynthBuffLoop, RynthVitals } = await loadModules();
  const fx = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
  const T0 = fx.meta.t0Ms, landsMs = fx.meta.landsMs;

  const rows = [];
  let unexpected = 0;
  for (const sc of fx.scenarios) {
    if (sc.jsSkip) {
      rows.push({ name: sc.name, rules: sc.rules.join(","), verdict: "cs-only", detail: "no JS counterpart (see note)" });
      continue;
    }
    const { casts, logs } = runScenario(sc, T0, landsMs, RynthBuffLoop, RynthVitals);
    const csCasts = sc.expected.casts;
    const { verdict, detail } = verdictFor(csCasts, casts);
    const flagged = sc.expectDiverge === true;
    let v = verdict;
    if (verdict === "DIVERGE") v = flagged ? "DIVERGE(expected)" : "DIVERGE(UNEXPECTED)";
    else if (flagged) v = `${verdict}(!expected-diverge)`; // authored probe did NOT diverge — also needs analysis
    if (v.includes("UNEXPECTED") || v.includes("!expected")) unexpected++;
    rows.push({ name: sc.name, rules: sc.rules.join(","), verdict: v, detail, logs });
  }

  const W = Math.max(...rows.map((r) => r.name.length)) + 1;
  for (const r of rows)
    console.log(`${r.verdict.padEnd(26)} ${r.name.padEnd(W)} [${r.rules}] ${r.detail}`);

  const count = (p) => rows.filter((r) => r.verdict.startsWith(p)).length;
  console.log(
    `\nTOTAL: ${rows.length} scenarios — agree=${count("agree")} ` +
    `(latency=${count("agree-latency")}) diverge-expected=${count("DIVERGE(expected")} ` +
    `diverge-UNEXPECTED=${count("DIVERGE(UNEXPECTED")} cs-only=${count("cs-only")}`
  );
  if (unexpected > 0) {
    console.log(`\n${unexpected} scenario(s) contradict their authored expectation — analyze before trusting fixtures.json.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
