#!/usr/bin/env node
// rynth_ai_eval_test.cjs — director eval harness (rynth/ai/eval/scenarios.js):
// runs the REAL RynthAiDirector + actions.js + observe.js against every
// scripted scenario, offline. No infra, no network — the "LLM" is a canned
// reply list, the bot is a recording mock (SCENARIOS own both).
//
// Run: node rynth_ai_eval_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const aiUrl = (f) => pathToFileURL(path.join(__dirname, "rynth", "ai", f)).href;

(async () => {
  const evalMod = await import(aiUrl(path.join("eval", "scenarios.js")));
  const directorMod = await import(aiUrl("director.js"));
  const actionsMod = await import(aiUrl("actions.js"));
  const observeMod = await import(aiUrl("observe.js"));

  const { SCENARIOS, runScenarios, makeMockBot, makeMemoryJournal, makeScriptedClient, ensure } = evalMod;
  const { RynthAiDirector } = directorMod;
  const { executePlan, validateAction } = actionsMod;
  const { buildObservation } = observeMod;

  // ---- Module surface.
  check("exports: SCENARIOS is a non-empty array", Array.isArray(SCENARIOS) && SCENARIOS.length >= 5,
    `len=${SCENARIOS && SCENARIOS.length}`);
  check("exports: runScenarios/makeMockBot/makeMemoryJournal/makeScriptedClient/ensure",
    [runScenarios, makeMockBot, makeMemoryJournal, makeScriptedClient, ensure].every((f) => typeof f === "function"));

  // ---- Every scenario has the documented shape.
  for (const sc of SCENARIOS) {
    check(`shape: ${sc.name}`,
      typeof sc.name === "string" && sc.name.length > 0
      && typeof sc.bot === "function"
      && Array.isArray(sc.llmReplies) && sc.llmReplies.length >= 1
      && sc.llmReplies.every((r) => typeof r === "string" && r.length > 0)
      && typeof sc.expect === "function");
  }

  // ---- The suite structurally exercises extractJson: at least one fenced
  // reply and at least one reply that is NOT bare parseable JSON.
  const allReplies = SCENARIOS.flatMap((s) => s.llmReplies);
  const bareParses = (s) => { try { JSON.parse(s); return true; } catch { return false; } };
  check("replies: at least one ```json-fenced reply", allReplies.some((r) => r.includes("```json")));
  check("replies: at least one prose/noisy (non-bare-JSON) reply", allReplies.some((r) => !bareParses(r)));
  check("replies: at least one with no extractable JSON at all (malformed path)",
    allReplies.some((r) => !r.includes("}")));

  // ---- Required situations are covered by the suite (task contract).
  const names = SCENARIOS.map((s) => s.name).join("\n");
  check("coverage: low loot value scenario", /loot/i.test(names));
  check("coverage: dangerous vitals scenario", /vitals/i.test(names));
  check("coverage: malformed reply scenario", /malformed/i.test(names));

  // ---- Full run with the REAL director + REAL actions.js + REAL observe.js
  // explicitly injected.
  {
    const run = await runScenarios({
      RynthAiDirector,
      observe: buildObservation,
      execute: executePlan,
      validate: validateAction,
    });
    check("run(real deps): shape", run && typeof run.passed === "number"
      && typeof run.failed === "number" && Array.isArray(run.results));
    check("run(real deps): all scenarios pass", run.failed === 0 && run.passed === SCENARIOS.length,
      JSON.stringify(run.results.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error && r.error.split("\n")[0] })), null, 2));
    for (let i = 0; i < run.results.length; i++) {
      const r = run.results[i];
      // Task contract: every llmReplies string is handled WITHOUT the
      // director throwing — one resolved check-in per scripted reply.
      check(`no-throw: ${r.name}`,
        r.checkins.length === SCENARIOS[i].llmReplies.length && r.checkins.every((c) => c.resolved === true),
        JSON.stringify(r.checkins.map((c) => ({ resolved: c.resolved, error: c.error }))));
    }
  }

  // ---- Same run relying on director.js's OWN defaults (observe/execute/
  // validate omitted -> the real modules via director.js imports).
  {
    const run = await runScenarios({ RynthAiDirector });
    check("run(director defaults): all scenarios pass", run.failed === 0 && run.passed === SCENARIOS.length,
      JSON.stringify(run.results.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error && r.error.split("\n")[0] }))));
  }

  // ---- Harness reports (not throws) a failing scenario.
  {
    const broken = {
      name: "deliberately-failing",
      bot: () => makeMockBot(),
      llmReplies: ['{"analysis": "x", "actions": [{"type": "none"}], "next_check_minutes": 5}'],
      expect() { throw new Error("expected failure for the harness test"); },
    };
    const run = await runScenarios({ RynthAiDirector, scenarios: [broken] });
    check("harness: failing expect -> failed result, no throw",
      run.passed === 0 && run.failed === 1 && run.results[0].ok === false
      && /expected failure/.test(run.results[0].error || ""));
  }

  // ---- A scenario whose bot factory explodes is a failed result too.
  {
    const explosive = {
      name: "bot-factory-throws",
      bot: () => { throw new Error("no bot for you"); },
      llmReplies: ["{}"],
      expect() {},
    };
    const run = await runScenarios({ RynthAiDirector, scenarios: [explosive] });
    check("harness: throwing bot factory -> failed result, no throw",
      run.failed === 1 && /no bot for you/.test(run.results[0].error || ""));
  }

  // ---- Missing the required dep throws loudly.
  {
    let threw = null;
    try { await runScenarios({}); } catch (e) { threw = e; }
    check("harness: missing RynthAiDirector dep throws", !!threw && /RynthAiDirector/.test(threw.message));
  }

  // ---- Belt-and-braces on the malformed scenario, independent of its own
  // expect(): run it directly and re-assert the bot is pristine.
  {
    const sc = SCENARIOS.find((s) => /malformed-reply/.test(s.name));
    check("direct: malformed scenario exists", !!sc);
    if (sc) {
      const bot = sc.bot();
      const journal = makeMemoryJournal();
      const client = makeScriptedClient(sc.llmReplies);
      const d = new RynthAiDirector(bot, {
        client, journal, observe: buildObservation, execute: executePlan, validate: validateAction,
      });
      const r = await d.checkNow(); // not started: no timer to clean up
      check("direct: malformed -> plan null, error surfaced, no rejection",
        r && r.plan === null && typeof r.error === "string");
      check("direct: bot untouched",
        bot.loot.minValue === 500 && bot._calls.pause === 0 && bot._calls.goto.length === 0
        && bot._calls.say.length === 0 && bot._calls.stopGoto === 0 && bot.kernel.running === true);
      check("direct: error journaled once",
        journal.entries.filter((e) => e.kind === "error").length === 1,
        JSON.stringify(journal.entries));
    }
  }

  // ---- Mock bot renders a full observation through the REAL observe.js
  // (no "n/a" for the surfaces scenarios assert on).
  {
    const bot = makeMockBot({ hp: 15, lootMinValue: 50 });
    const { text, data } = buildObservation(bot, { journalTail: "TAIL-MARK" });
    check("mockbot: observation carries vitals/loot/threats/journal",
      text.includes("vitals: hp=15%") && text.includes("loot_min: 50")
      && /threats \(\d+\/\d+\):/.test(text) && text.includes("TAIL-MARK"),
      text);
    check("mockbot: structured data populated", !!data.position && !!data.kernel && !!data.vitals
      && Array.isArray(data.threats) && data.loot && data.loot.minValue === 50);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
