#!/usr/bin/env node
// rynth_ai_world_test.cjs — unit tests for rynth/ai/tools/world.js (the general
// use_object interaction primitive) via a mock host. No infra.

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

const NEARBY = {
  0x5001: "Exit to Holtburg",
  0x5002: "Sedor Wystan the Blacksmith",
  0x5003: "Training Chest",
  0x5004: "Sedor's Apprentice",
};
function makeHost() {
  const calls = [];
  return {
    calls,
    NearbyGuids: () => Object.keys(NEARBY).map((k) => Number(k)),
    TryGetObjectName: (g) => NEARBY[g] ?? null,
    UseObject: (g) => { calls.push(["use", g]); return true; },
  };
}

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { worldActions } = await import(modUrl("rynth/ai/tools/world.js"));
  const { composeAiExtensions } = await import(modUrl("rynth/ai/extensions.js"));

  const defs = worldActions();
  const byType = Object.fromEntries(defs.map((d) => [d.type, d]));
  check("one def (use_object)", Object.keys(byType).length === 1 && byType.use_object);

  // use by exact name -> portal
  {
    const journal = makeJournal(); const host = makeHost(); const bot = { host };
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "Exit to Holtburg" }, { journal });
    check("use_object exact name (portal)", r.ok && host.calls.some((c) => c[0] === "use" && c[1] === 0x5001), JSON.stringify(r));
    check("use_object journaled", journal.entries.some((e) => /use_object Exit to Holtburg/.test(e.text)));
  }
  // use by guid
  {
    const host = makeHost(); const bot = { host };
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "0x5002" }, { journal: makeJournal() });
    check("use_object by guid", r.ok && host.calls.some((c) => c[1] === 0x5002), JSON.stringify(r));
  }
  // substring unique
  {
    const host = makeHost(); const bot = { host };
    const r = await byType.use_object.apply(bot, { type: "use_object", object: "chest" }, { journal: makeJournal() });
    check("use_object substring unique", r.ok && host.calls.some((c) => c[1] === 0x5003), JSON.stringify(r));
  }
  // ambiguous substring
  {
    const r = await byType.use_object.apply({ host: makeHost() }, { type: "use_object", object: "sedor" }, { journal: makeJournal() });
    check("use_object ambiguous fails", !r.ok && /ambiguous/i.test(r.error), r.error);
  }
  // no match
  {
    const r = await byType.use_object.apply({ host: makeHost() }, { type: "use_object", object: "dragon" }, { journal: makeJournal() });
    check("use_object no match fails", !r.ok && /no nearby object/.test(r.error), r.error);
  }
  // hostless degrade
  {
    const r = await byType.use_object.apply({ host: {} }, { type: "use_object", object: "portal" }, { journal: makeJournal() });
    check("use_object hostless -> ok:false", !r.ok && /unavailable/.test(r.error), r.error);
  }
  // extensions wiring
  {
    const ext = composeAiExtensions({ host: makeHost() }, { journal: makeJournal(), config: { knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false } });
    check("default-on: use_object registered", !!ext.extActions.use_object);
    check("prompt advertises use_object", ext.directorDeps.systemPrompt.includes("use_object"));
    check("validate routes use_object", ext.directorDeps.validate({ type: "use_object", object: "portal" }).ok === true);
  }
  {
    const ext = composeAiExtensions({ host: makeHost() }, { journal: makeJournal(), config: { world: false, knowledge: false, dungeonNav: false, wbt: false, economy: false, advancement: false } });
    check("world:false -> not registered", !ext.extActions.use_object);
  }

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
