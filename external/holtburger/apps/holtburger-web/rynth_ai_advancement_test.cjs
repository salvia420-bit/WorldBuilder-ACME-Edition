#!/usr/bin/env node
// rynth_ai_advancement_test.cjs — unit tests for rynth/ai/tools/advancement.js
// (the playtester's advancement hands: raise_attribute / raise_vital /
// raise_skill / train_skill) + the webhost advancement plane it drives, via a
// mock host. No infra.
//
// Run: node rynth_ai_advancement_test.cjs   (exits 1 on any FAIL)

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

// Normalized snapshot shape RynthWebHost.TryGetPlayerStats() returns.
function makeStats() {
  return {
    level: 3,
    unspentXp: 500,
    attributes: { 1: { current: 10, base: 10, ranks: 0 }, 2: { current: 10, base: 10, ranks: 0 }, 6: { current: 10, base: 10, ranks: 0 } },
    skills: {
      6: { current: 54, base: 54, ranks: 0, training: 3, nextCost: 118 },  // MeleeDefense specialized
      33: { current: 28, base: 28, ranks: 0, training: 2, nextCost: 90 },  // LifeMagic trained
      32: { current: 0, base: 0, ranks: 0, training: 1, nextCost: 0 },     // ItemEnchantment untrained
    },
    vitals: { 1: { current: 5, base: 5, max: 5 }, 3: { current: 10, base: 10, max: 10 }, 5: { current: 10, base: 10, max: 10 } },
  };
}

function makeHost({ credits = 10, stats = makeStats() } = {}) {
  const calls = [];
  return {
    calls,
    TryGetPlayerStats: () => JSON.parse(JSON.stringify(stats)),
    TryGetSkillCredits: () => credits,
    RaiseAttribute: (id, xp) => { calls.push(["raiseAttr", id, xp]); return true; },
    RaiseVital: (id, xp) => { calls.push(["raiseVital", id, xp]); return true; },
    RaiseSkill: (id, xp) => { calls.push(["raiseSkill", id, xp]); return true; },
    TrainSkill: (id, cr) => { calls.push(["trainSkill", id, cr]); return true; },
  };
}

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { advancementActions, ADVANCEMENT_MAPS } = await import(modUrl("rynth/ai/tools/advancement.js"));
  const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));

  const defs = advancementActions();
  const byType = Object.fromEntries(defs.map((d) => [d.type, d]));
  check("four defs", Object.keys(byType).length === 4 && byType.raise_attribute && byType.raise_vital && byType.raise_skill && byType.train_skill);
  check("maps present", ADVANCEMENT_MAPS.SKILLS.finesse_weapons === 46 && ADVANCEMENT_MAPS.ATTRS.endurance === 2 && ADVANCEMENT_MAPS.TRAINED_COST[32] === 8);

  // --- raise_attribute ----------------------------------------------------
  {
    const journal = makeJournal(); const host = makeHost(); const bot = { host };
    const r = await byType.raise_attribute.apply(bot, { type: "raise_attribute", attribute: "endurance", xp: 200 }, { journal });
    check("raise_attribute ok", r.ok && r.result.attribute === "endurance", JSON.stringify(r));
    check("raise_attribute called host (id 2)", host.calls.some((c) => c[0] === "raiseAttr" && c[1] === 2 && c[2] === 200));
    check("raise_attribute journaled", journal.entries.some((e) => /raise_attribute endurance/.test(e.text)));
  }
  {
    const bot = { host: makeHost() };
    const r = await byType.raise_attribute.apply(bot, { type: "raise_attribute", attribute: "endurance", xp: 9999 }, { journal: makeJournal() });
    check("raise_attribute over-spend fails", !r.ok && /unspent XP/.test(r.error), r.error);
  }
  {
    const bot = { host: makeHost() };
    const r = await byType.raise_attribute.apply(bot, { type: "raise_attribute", attribute: "wisdom", xp: 10 }, { journal: makeJournal() });
    check("raise_attribute unknown attr fails", !r.ok && /unknown attribute/.test(r.error), r.error);
    const r2 = await byType.raise_attribute.apply(bot, { type: "raise_attribute", attribute: "self", xp: 0 }, { journal: makeJournal() });
    check("raise_attribute xp<=0 fails", !r2.ok && /positive integer/.test(r2.error), r2.error);
  }

  // --- raise_vital --------------------------------------------------------
  {
    const journal = makeJournal(); const host = makeHost(); const bot = { host };
    const r = await byType.raise_vital.apply(bot, { type: "raise_vital", vital: "health", xp: 100 }, { journal });
    check("raise_vital ok + host id 1", r.ok && host.calls.some((c) => c[0] === "raiseVital" && c[1] === 1 && c[2] === 100), JSON.stringify(r));
  }

  // --- raise_skill --------------------------------------------------------
  {
    const journal = makeJournal(); const host = makeHost(); const bot = { host };
    const r = await byType.raise_skill.apply(bot, { type: "raise_skill", skill: "life_magic", xp: 90 }, { journal });
    check("raise_skill (trained) ok + host id 33", r.ok && host.calls.some((c) => c[0] === "raiseSkill" && c[1] === 33 && c[2] === 90), JSON.stringify(r));
  }
  {
    const bot = { host: makeHost() };
    const r = await byType.raise_skill.apply(bot, { type: "raise_skill", skill: "item_enchantment", xp: 50 }, { journal: makeJournal() });
    check("raise_skill on untrained fails", !r.ok && /must be Trained/.test(r.error), r.error);
  }
  {
    // name normalization: "Melee Defense" -> melee_defense (id 6, specialized)
    const host = makeHost(); const bot = { host };
    const r = await byType.raise_skill.apply(bot, { type: "raise_skill", skill: "Melee Defense", xp: 118 }, { journal: makeJournal() });
    check("raise_skill name-normalized (spaces)", r.ok && host.calls.some((c) => c[0] === "raiseSkill" && c[1] === 6), JSON.stringify(r));
  }

  // --- train_skill --------------------------------------------------------
  {
    const journal = makeJournal(); const host = makeHost({ credits: 10 }); const bot = { host };
    const r = await byType.train_skill.apply(bot, { type: "train_skill", skill: "item_enchantment" }, { journal });
    check("train_skill ok (cost 8) + host id 32", r.ok && r.result.creditsCost === 8 && host.calls.some((c) => c[0] === "trainSkill" && c[1] === 32 && c[2] === 8), JSON.stringify(r));
  }
  {
    const bot = { host: makeHost({ credits: 2 }) };
    const r = await byType.train_skill.apply(bot, { type: "train_skill", skill: "item_enchantment" }, { journal: makeJournal() });
    check("train_skill insufficient credits fails", !r.ok && /skill credits/.test(r.error), r.error);
  }
  {
    const bot = { host: makeHost() };
    const r = await byType.train_skill.apply(bot, { type: "train_skill", skill: "life_magic" }, { journal: makeJournal() });
    check("train_skill already-trained fails", !r.ok && /already/.test(r.error), r.error);
  }

  // --- hostless degradation (older wasm) ----------------------------------
  {
    const bot = { host: {} };
    for (const t of ["raise_attribute", "raise_vital", "raise_skill", "train_skill"]) {
      const a = { type: t, attribute: "endurance", vital: "health", skill: "life_magic", xp: 10 };
      const r = await byType[t].apply(bot, a, { journal: makeJournal() });
      check(`${t} hostless -> ok:false`, !r.ok && /unavailable/.test(r.error), r.error);
    }
  }

  // --- extensions wiring --------------------------------------------------
  {
    const ext = composeAiExtensions({ host: makeHost() }, { journal: makeJournal(), config: { knowledge: false, dungeonNav: false, wbt: false, economy: false } });
    check("default-on: 4 advancement actions registered", ["raise_attribute", "raise_vital", "raise_skill", "train_skill"].every((t) => ext.extActions[t]));
    check("prompt advertises advancement actions", ext.directorDeps.systemPrompt.includes("train_skill") && ext.directorDeps.systemPrompt.includes("raise_attribute"));
    const validate = ext.directorDeps.validate;
    check("validate routes advancement action", validate({ type: "raise_attribute", attribute: "endurance", xp: 100 }).ok === true);
  }
  {
    const ext = composeAiExtensions({ host: makeHost() }, { journal: makeJournal(), config: { knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false } });
    check("advancement:false -> not registered", !ext.extActions.raise_attribute && !ext.extActions.train_skill);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
