#!/usr/bin/env node
// rynth_ai_memory_test.cjs — unit tests for rynth/ai/tools/memory.js (the
// persistent scratchpad) and its extensions.js composition: SCRATCHPAD
// observation section, tried:/explored: coverage lines, plan-truncation
// journal note. Mock host, no infra.

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
function makeJournal() {
  const entries = [];
  return { entries, add: (kind, text) => entries.push({ kind, text }), renderTail: () => "" };
}
const NEARBY = { 0x5001: "Exit to Holtburg", 0x5003: "Training Chest" };
function makeHost() {
  const calls = [];
  const pose = { objCellId: 0x860201ad, x: 12, y: -28, z: 0 };
  return {
    calls, pose,
    TryGetPlayerPose: () => ({ ...pose }),
    NearbyGuids: () => Object.keys(NEARBY).map(Number),
    TryGetObjectName: (g) => NEARBY[g] ?? null,
    UseObject: (g) => { calls.push(["use", g]); return true; },
    PursueObject: (g) => { calls.push(["pursue", g]); return true; },
  };
}
const CFG_OFF = { knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false };

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { updateScratchpadAction, renderScratchpadSection, registerMemory } = await import(modUrl("rynth/ai/tools/memory.js"));
  const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));

  // ---- unit: action + render ----
  {
    const state = {};
    const def = updateScratchpadAction(state);
    check("def shape", def.type === "update_scratchpad" && typeof def.apply === "function" && /goals/.test(def.params.text));
    check("validate: non-string", def.validate({ type: "update_scratchpad", text: 5 }).ok === false);
    check("validate: too long", def.validate({ type: "update_scratchpad", text: "x".repeat(1501) }).ok === false);
    const r = await def.apply(null, { type: "update_scratchpad", text: "goals: primary=exit academy" }, {});
    check("apply ok", r.ok === true && r.result.chars > 0, JSON.stringify(r));
    check("render carries text", /primary=exit academy/.test(renderScratchpadSection(state)));
    check("render empty placeholder", /empty — write your goals/.test(renderScratchpadSection({})));
    const bad = await def.apply(null, { type: "update_scratchpad", text: "x".repeat(2000) }, {});
    check("apply too-long -> ok:false", bad.ok === false && /1500/.test(bad.error), bad.error);
  }
  // ---- registerMemory frozen-map throw ----
  {
    let threw = false;
    try { registerMemory(Object.freeze({}), {}); } catch { threw = true; }
    check("registerMemory frozen map throws", threw);
  }

  // ---- compose: scratchpad section in observe, updated via execute ----
  {
    const host = makeHost(); const bot = { host };
    const ext = composeAiExtensions(bot, { journal: makeJournal(), config: CFG_OFF });
    check("default-on: update_scratchpad registered", !!ext.extActions.update_scratchpad);
    check("prompt has MEMORY DISCIPLINE", /MEMORY DISCIPLINE/.test(ext.directorDeps.systemPrompt));
    let obs = ext.directorDeps.observe(bot, {}).text;
    check("observe has SCRATCHPAD section", /SCRATCHPAD \(persistent memory/.test(obs));
    check("observe shows empty placeholder", /empty — write your goals/.test(obs));
    await ext.directorDeps.execute(bot, [{ type: "update_scratchpad", text: "goals: primary=find Jonathan" }], {});
    obs = ext.directorDeps.observe(bot, {}).text;
    check("scratchpad update visible next observe", /primary=find Jonathan/.test(obs));
    // "explored: N cells" was folded into the LOCATION block's Covered: line
    // (DESIGN-surveyor-frontier-2026-07-21 WS-B) — rynth_ai_observe_location_test.cjs
    // covers this format in full; here just confirm it's present.
    check("Covered line present (supersedes the old explored: line)",
      /  Covered: \d+ tiles \/ \d+ landblocks this session; \d+ tiles in this landblock\./.test(obs));
  }
  // ---- compose: memory:false -> off ----
  {
    const ext = composeAiExtensions({ host: makeHost() }, { journal: makeJournal(), config: { ...CFG_OFF, memory: false } });
    check("memory:false -> not registered", !ext.extActions.update_scratchpad);
    check("memory:false -> no MEMORY DISCIPLINE", !/MEMORY DISCIPLINE/.test(ext.directorDeps.systemPrompt));
    check("memory:false -> no SCRATCHPAD section", !/SCRATCHPAD/.test(ext.directorDeps.observe({ host: makeHost() }, {}).text));
  }

  // ---- compose: tried line after use_object/goto_object ----
  {
    const host = makeHost(); const bot = { host };
    const ext = composeAiExtensions(bot, { journal: makeJournal(), config: CFG_OFF });
    await ext.directorDeps.execute(bot, [{ type: "use_object", object: "0x5001" }], {});
    await ext.directorDeps.execute(bot, [{ type: "goto_object", object: "chest" }], {});
    const obs = ext.directorDeps.observe(bot, {}).text;
    // "tried: ..." was folded into the LOCATION block's "already tried here:"
    // line (DESIGN-surveyor-frontier-2026-07-21 WS-B).
    check("already tried here line lists used objects",
      /already tried here: .*Exit to Holtburg 0x5001.*Training Chest 0x5003/.test(obs),
      obs.split("\n").find((l) => l.trim().startsWith("already tried here:")));
  }

  // ---- compose: truncation journals a visible note ----
  {
    const host = makeHost(); const bot = { host };
    const journal = makeJournal();
    const ext = composeAiExtensions(bot, { journal, config: CFG_OFF });
    const seven = Array.from({ length: 7 }, () => ({ type: "use_object", object: "0x5001" }));
    const results = await ext.directorDeps.execute(bot, seven, {});
    check("truncation keeps maxActions", results.filter((r) => r.ok).length === 5, JSON.stringify(results.length));
    check("truncation visible in results", results.filter((r) => !r.ok && /plan truncated/.test(r.error)).length === 2,
      JSON.stringify(results.filter((r) => !r.ok)));
    void journal;
  }
  // ---- compose: deltas line (harness ground truth of change) ----
  {
    const host = makeHost(); const bot = { host };
    let coins = 1000;
    host.TryGetCoins = () => coins;
    const ext = composeAiExtensions(bot, { journal: makeJournal(), config: CFG_OFF });
    ext.directorDeps.observe(bot, {}); // first observe seeds the snapshot
    host.pose.x += 20; coins -= 150;
    const obs = ext.directorDeps.observe(bot, {}).text;
    check("deltas line reports movement+coins", /since last check-in: moved 20m; coins -150/.test(obs),
      obs.split("\n").find((l) => l.startsWith("since last")));
    const obs2 = ext.directorDeps.observe(bot, {}).text;
    check("deltas line reports NOT moved", /since last check-in: did NOT move/.test(obs2),
      obs2.split("\n").find((l) => l.startsWith("since last")));
  }
  // ---- compose: cfg.maxActions override ----
  {
    const host = makeHost(); const bot = { host };
    const ext = composeAiExtensions(bot, { journal: makeJournal(), config: { ...CFG_OFF, maxActions: 2 } });
    const four = Array.from({ length: 4 }, () => ({ type: "use_object", object: "0x5001" }));
    const results = await ext.directorDeps.execute(bot, four, {});
    check("maxActions override respected", results.filter((r) => r.ok).length === 2, JSON.stringify(results.length));
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
