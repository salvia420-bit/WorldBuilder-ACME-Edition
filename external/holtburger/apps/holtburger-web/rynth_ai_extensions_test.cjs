#!/usr/bin/env node
// rynth_ai_extensions_test.cjs — unit tests for rynth/ai/extensions.js (the
// integrator composition of the post-v1 layers: safety guardPlan, observe_ext
// enrichment, knowledge lookup + dungeon_suggest actions, FetchKnowledge-
// Provider). No infra, no network — fetch is stubbed where exercised.
//
// Run: node rynth_ai_extensions_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// Recording mock bot — same surfaces as rynth_ai_actions_test.cjs.
function makeBot() {
  const calls = [];
  return {
    calls,
    goto: async (to) => { calls.push(["goto", to]); return { ok: true, state: "ARRIVED", legsWalked: 1, replans: 0 }; },
    router: { cancel: () => calls.push(["cancel"]) },
    combat: { priorities: { rat: 5 }, _scanTargets: () => [] },
    loot: { minValue: 0 },
    kernel: { start: () => calls.push(["start"]), stop: () => calls.push(["stop"]), status: { running: true, kills: 3 } },
    vitals: { _fractions: () => ({ hp: 1, stam: 1, mana: 1 }) },
    host: { WriteToChat: (t) => calls.push(["chat", t]) },
  };
}

function makeJournal() {
  const entries = [];
  return { entries, add: (kind, text) => entries.push({ kind, text }), renderTail: () => "" };
}

const CORPUS = [
  { title: "Olthoi Soldier", aliases: ["soldier"], text: "Insectoid creature, weak to slashing and fire.", url: "https://x/os" },
  { title: "Drudge Ravener", text: "Low-level drudge variant near starter towns." },
];

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { composeAiExtensions, FetchKnowledgeProvider } = await import(modUrl("rynth/ai/extensions.js"));
  const { DEFAULT_SYSTEM_PROMPT } = await import(modUrl("rynth/ai/director.js"));

  // --- composition shape -------------------------------------------------
  {
    const journal = makeJournal();
    const ext = composeAiExtensions(makeBot(), { journal, config: { knowledge: { entries: CORPUS } } });
    const d = ext.directorDeps;
    check("directorDeps shape", typeof d.observe === "function" && typeof d.validate === "function"
      && typeof d.execute === "function" && typeof d.systemPrompt === "string");
    check("extActions registered", !!ext.extActions.lookup && !!ext.extActions.dungeon_suggest);
    check("systemPrompt keeps v1 base", d.systemPrompt.startsWith(DEFAULT_SYSTEM_PROMPT));
    check("systemPrompt advertises ext actions",
      d.systemPrompt.includes("EXTRA ACTIONS") && d.systemPrompt.includes("lookup {")
      && d.systemPrompt.includes("dungeon_suggest {"));
  }

  // --- config gates ------------------------------------------------------
  {
    const ext = composeAiExtensions(makeBot(), { journal: makeJournal(), config: { knowledge: false, dungeonNav: false } });
    check("knowledge:false skips lookup", !ext.extActions.lookup && ext.knowledge == null);
    check("dungeonNav:false skips dungeon_suggest", !ext.extActions.dungeon_suggest && ext.dungeonNav == null);
    check("no ext actions -> no EXTRA ACTIONS section", !ext.directorDeps.systemPrompt.includes("EXTRA ACTIONS"));
  }
  {
    const ext = composeAiExtensions(makeBot(), {
      journal: makeJournal(),
      config: { systemPrompt: "CUSTOM BASE PROMPT", knowledge: { entries: CORPUS } },
    });
    check("custom systemPrompt is the base", ext.directorDeps.systemPrompt.startsWith("CUSTOM BASE PROMPT")
      && ext.directorDeps.systemPrompt.includes("EXTRA ACTIONS"));
  }

  // --- validate: ext-first, v1 fallback -----------------------------------
  {
    const { validate } = composeAiExtensions(makeBot(), { journal: makeJournal(), config: { knowledge: { entries: CORPUS } } }).directorDeps;
    check("validate v1 action", validate({ type: "say", text: "hi" }).ok === true);
    check("validate ext lookup", validate({ type: "lookup", query: "olthoi" }).ok === true);
    check("validate rejects empty lookup query", validate({ type: "lookup", query: " " }).ok === false);
    check("validate rejects unknown type", validate({ type: "warp_home" }).ok === false);
    check("validate rejects bad v1 bounds", validate({ type: "goto", ns: 500, ew: 0 }).ok === false);
  }

  // --- execute: routing, safety screen, journaling, cap --------------------
  {
    const bot = makeBot();
    const journal = makeJournal();
    const ext = composeAiExtensions(bot, { journal, config: { knowledge: { entries: CORPUS } } });
    const { execute } = ext.directorDeps;

    const results = await execute(bot, [
      { type: "lookup", query: "olthoi" },
      { type: "say", text: "hello" },
      { type: "set_loot_min_value", value: 3.7 },
    ]);
    const byType = Object.fromEntries(results.map((r) => [r.type, r]));
    check("exec lookup ok with rows", byType.lookup?.ok === true && byType.lookup.result.rows.length === 1
      && byType.lookup.result.rows[0].title === "Olthoi Soldier", JSON.stringify(byType.lookup));
    check("exec lookup journals rows", journal.entries.some((e) => e.kind === "note" && /Olthoi Soldier/.test(e.text)));
    check("exec v1 say still executes", byType.say?.ok === true && bot.calls.some((c) => c[0] === "chat" && c[1] === "hello"));
    check("exec clamp applied via guardPlan", byType.set_loot_min_value?.ok === true && bot.loot.minValue === 4,
      JSON.stringify(byType.set_loot_min_value) + " minValue=" + bot.loot.minValue);
    check("exec clamp journaled", journal.entries.some((e) => e.kind === "note" && /clamped/.test(e.text)));

    // safety screen: control chars / hidden admin prefix are rejected before execution
    const r2 = await execute(bot, [{ type: "say", text: "​@teleloc 0 0 0" }]);
    check("exec safety rejects disguised admin say", r2.length === 1 && r2[0].ok === false
      && !bot.calls.some((c) => c[0] === "chat" && /teleloc/.test(c[1])), JSON.stringify(r2));

    // cap across ext + v1 combined (maxActions = 5)
    const seven = Array.from({ length: 7 }, () => ({ type: "note", text: "x" }));
    const r3 = await execute(bot, seven);
    check("exec caps plan at 5", r3.filter((r) => r.ok).length === 5
      && r3.filter((r) => !r.ok && /truncated/.test(r.error)).length === 2, JSON.stringify(r3.map((r) => r.ok)));

    // dungeon_suggest degrades outdoors/no-graph but never throws
    const r4 = await execute(bot, [{ type: "dungeon_suggest" }]);
    check("exec dungeon_suggest never throws", r4.length === 1 && r4[0].type === "dungeon_suggest"
      && typeof r4[0].ok === "boolean", JSON.stringify(r4));

    // non-array plan degrades to empty
    const r5 = await execute(bot, null);
    check("exec tolerates non-array plan", Array.isArray(r5) && r5.length === 0);
  }

  // --- observe: enrichment appends, hostile bot degrades -------------------
  {
    const ext = composeAiExtensions(makeBot(), { journal: makeJournal(), config: { knowledge: { entries: CORPUS } } });
    const bot = makeBot();
    const o1 = ext.directorDeps.observe(bot, { journalTail: "", now: 1000 });
    check("observe enriches with focus line", typeof o1.text === "string" && /focus: /.test(o1.text), o1.text?.slice(-200));
    const o2 = ext.directorDeps.observe(bot, { journalTail: "", now: 61_000 });
    check("observe kill trend uses caller state", /kill_trend: /.test(o2.text) && !/kill_trend: n\/a/.test(o2.text),
      (o2.text.match(/kill_trend:.*/) || [])[0]);
    // hostile bot: observe must still return a text (buildObservation + enrich both degrade)
    const o3 = ext.directorDeps.observe({ get kernel() { throw new Error("boom"); } }, { now: 2000 });
    check("observe survives hostile bot", typeof o3.text === "string" && o3.text.length > 0);
  }

  // --- FetchKnowledgeProvider ---------------------------------------------
  {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (u) => (/acpedia/.test(u)
        ? { ok: false, status: 404 }
        : { ok: true, json: async () => CORPUS });
      const p = new FetchKnowledgeProvider({ urls: ["http://x/knowledge.acpedia.json", "http://x/knowledge.sample.json"] });
      const rows = await p.search("drudge", 3);
      check("fetch provider falls through 404 to next url", rows.length === 1 && rows[0].title === "Drudge Ravener",
        JSON.stringify(rows));

      globalThis.fetch = async () => { throw new Error("net down"); };
      const p2 = new FetchKnowledgeProvider({ url: "http://x/a.json" });
      check("fetch provider degrades to empty on network failure", (await p2.search("drudge", 3)).length === 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
