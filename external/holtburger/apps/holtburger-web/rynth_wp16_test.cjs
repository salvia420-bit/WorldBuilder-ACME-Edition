#!/usr/bin/env node
// rynth_wp16_test.cjs — unit tests for WP-16: persona/goal-gated steady-state
// observation lines + verb catalog (extensions.js/observe.js) and the journal
// self-echo collapse (director.js). No infra, no network — a hand-built mock
// bot/host and an in-memory AiJournal. All clocks injected via opts.now.
//
//   C4-2/C4-3: the combat/econ/advancement steady-state lines (vitals, buffs,
//   loot_min/priorities from observe.js; advancement, kill_trend, burden,
//   portals from observe_ext.js) and the economy/advancement VERB groups are
//   gated on the ACTIVE GOAL SET (not the persona name), so a pure explorer
//   sheds them while a future gear goal re-enables exactly what it needs.
//   The director's journal tail collapses its own plan/result self-echo (the
//   Qalaba'r self-reinforcement) while keeping every note/error.
//
// Run: node rynth_wp16_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const NOW = 1_800_000_000_000; // fixed clock

// Mock bot with the surfaces buildObservation/observe_ext read for the gated
// steady-state lines: vitals/buff/loot/combat come off the bot, the host stays
// minimal (probes degrade to "n/a" lines, which still carry the prefix we gate).
function makeBot() {
  return {
    host: {
      NearbyGuids: () => [],
      TryGetPlayerPose: () => null,
      onEvent: () => {},
      onTick: () => {},
    },
    vitals: { _fractions: () => ({ hp: 80, stam: 90, mana: 70 }) },
    buff: { status: { ready: true, active: 2, desired: 3, parked: [], pending: 0 } },
    loot: { minValue: 5 },
    combat: { priorities: { rat: 5 }, locked: null, _scanTargets: () => [] },
    kernel: { running: true, status: { action: "idle", kills: 3, looted: 1 }, combat: { enabled: false } },
  };
}

// Prefixes of the eight gated steady-state lines.
const STEADY_PREFIXES = ["vitals:", "buffs:", "loot_min:", "priorities:", "advancement:", "kill_trend:", "burden:", "portals:"];
const hasAny = (text, needles) => needles.some((n) => text.includes(n));
const hasAll = (text, needles) => needles.every((n) => text.includes(n));

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const ob = await import(modUrl("rynth/ai/observe.js"));
  const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));
  const { RynthAiDirector } = await import(modUrl("rynth/ai/director.js"));
  const { AiJournal } = await import(modUrl("rynth/ai/journal.js"));

  // ── 1. observe.js: showSteadyState gates its own combat/econ lines ────────
  {
    const withSS = ob.buildObservation(makeBot(), { now: NOW }).text; // default true
    const noSS = ob.buildObservation(makeBot(), { now: NOW, showSteadyState: false }).text;
    check("observe default renders vitals/buffs/loot_min/priorities",
      hasAll(withSS, ["vitals:", "buffs:", "loot_min:", "priorities:"]), withSS);
    check("observe showSteadyState:false omits those four lines",
      !hasAny(noSS, ["vitals:", "buffs:", "loot_min:", "priorities:"]), noSS);
    check("observe showSteadyState:false keeps ground-truth lines (uptime/nav)",
      noSS.includes("uptime:") && noSS.includes("nav:"), noSS);
    // data is whole regardless — observe_ext.js and others still read it.
    const dNo = ob.buildObservation(makeBot(), { now: NOW, showSteadyState: false }).data;
    check("observe showSteadyState:false leaves structured data intact",
      dNo && dNo.vitals && dNo.vitals.hp === 80 && dNo.buffs != null, JSON.stringify(dNo && dNo.vitals));
  }

  // ── 2. extensions.observe: explorer sheds ALL eight steady lines ──────────
  const OFF = { knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false, world: false, routes: false, memory: false, routeRecord: false };
  {
    const explorer = composeAiExtensions(makeBot(), { journal: mkJournal(), config: { persona: "explorer", ...OFF } });
    const def = composeAiExtensions(makeBot(), { journal: mkJournal(), config: { ...OFF } });
    const exText = explorer.directorDeps.observe(makeBot(), { now: NOW }).text;
    const defText = def.directorDeps.observe(makeBot(), { now: NOW }).text;
    check("explorer observation omits all 8 steady-state lines",
      !hasAny(exText, STEADY_PREFIXES), exText);
    check("explorer observation still carries perception (nearby/nav)",
      exText.includes("nav:") || exText.includes("nearby:"), exText);
    check("default persona observation keeps all 8 steady-state lines (unchanged)",
      hasAll(defText, STEADY_PREFIXES), defText);
  }

  // ── 3. renderExtCatalog: econ/advancement verbs gated by goal ─────────────
  {
    const explorer = composeAiExtensions(makeBot(), { journal: mkJournal(), config: { persona: "explorer" } });
    const def = composeAiExtensions(makeBot(), { journal: mkJournal(), config: {} });
    const exP = explorer.directorDeps.systemPrompt;
    const defP = def.directorDeps.systemPrompt;
    check("explorer prompt drops economy verbs (buy_items/sell_items)",
      !exP.includes("buy_items {") && !exP.includes("sell_items {"), "explorer prompt still lists econ verbs");
    check("explorer prompt drops advancement verbs (raise_skill/train_skill)",
      !exP.includes("raise_skill {") && !exP.includes("train_skill {"), "explorer prompt still lists adv verbs");
    check("explorer prompt keeps exploration verbs (use_object/hunt_start)",
      exP.includes("use_object {") && exP.includes("hunt_start {"), "explorer prompt lost world verbs");
    check("default prompt keeps econ + advancement verbs",
      defP.includes("buy_items {") && defP.includes("raise_skill {"), "default prompt missing gated verbs");
    // The gate only trims the PROMPT — validate/execute still recognize the verb.
    check("gated verb still registered (execute unaffected)",
      typeof explorer.extActions.buy_items === "object" && explorer.extActions.buy_items != null);
  }

  // ── 4. goal-set (not persona) gating: an explicit gear-ish goal re-enables ─
  {
    // goals:["explore","econ"] — no persona name at all; econ turns loot/econ
    // lines+verbs back on, advancement stays off (proves per-goal granularity).
    const gear = composeAiExtensions(makeBot(), { journal: mkJournal(), config: { goals: ["explore", "econ"] } });
    const p = gear.directorDeps.systemPrompt;
    const text = gear.directorDeps.observe(makeBot(), { now: NOW }).text;
    check("cfg.goals with econ re-enables steady-state lines",
      hasAll(text, ["vitals:", "loot_min:"]), text);
    check("cfg.goals with econ re-enables economy verbs",
      p.includes("buy_items {"), "econ goal did not restore econ verbs");
    check("cfg.goals without advancement still hides advancement verbs",
      !p.includes("raise_skill {"), "advancement verbs leaked without the goal");
  }

  // ── 5. director journal tail: collapse self-echo, keep notes ──────────────
  {
    const j = new AiJournal({ storageKey: "wp16_echo", maxEntries: 200 });
    j.add("note", "Samuel is an NPC not a vendor");        // curated durable note
    j.add("plan", "head to Qalaba'r | actions: goto | next: 5m");
    j.add("result", "goto:ok");
    j.add("plan", "head to Qalaba'r | actions: goto | next: 5m");
    j.add("result", "goto:ok");
    j.add("plan", "head to Qalaba'r | actions: goto | next: 5m");
    j.add("result", "goto:ok");
    const dir = new RynthAiDirector({}, { journal: j });
    const tail = dir._renderMemoryTail(8, 700);
    check("prior note survives the echo collapse", tail.includes("Samuel is an NPC not a vendor"), tail);
    check("consecutive plan echoes collapse to one line",
      (tail.match(/ plan: /g) || []).length === 1, tail);
    check("consecutive result echoes collapse to one line",
      (tail.match(/ result: /g) || []).length === 1, tail);
  }

  // ── 6. director journal tail: char-count drops >= 30% vs old window ───────
  {
    const j = new AiJournal({ storageKey: "wp16_chars", maxEntries: 200 });
    for (let i = 0; i < 12; i++) {
      j.add("plan", `check-in ${i}: survey the northern district, the frontier lies NW at ~40m, coverage steady | actions: goto, use_object | next: 4m`);
      j.add("result", `goto:ok use_object:ok — moved 12m this check-in, landblock unchanged, still charting sector ${i} of the district`);
    }
    const oldTail = j.renderTail(24, 2800); // the pre-WP-16 window
    const dir = new RynthAiDirector({}, { journal: j });
    const newTail = dir._renderMemoryTail(8, 700);
    check("new memory tail is >=30% shorter than renderTail(24,2800)",
      newTail.length > 0 && newTail.length <= oldTail.length * 0.7,
      `old=${oldTail.length} new=${newTail.length}`);
    check("new memory tail respects the 700-char budget", newTail.length <= 700, `len=${newTail.length}`);
  }

  // ── 7. _renderMemoryTail degrades to "" on a hostile journal ──────────────
  {
    const dir = new RynthAiDirector({}, { journal: { tail() { throw new Error("boom"); } } });
    check("_renderMemoryTail never throws (degrades to empty)", dir._renderMemoryTail(8, 700) === "");
    const dir2 = new RynthAiDirector({}, { journal: null });
    check("_renderMemoryTail tolerates a null journal", dir2._renderMemoryTail(8, 700) === "");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });

function mkJournal() {
  const entries = [];
  return { entries, add: (kind, text) => entries.push({ kind, text }), renderTail: () => "", tail: () => [] };
}
