#!/usr/bin/env node
// rynth_ai_knowledge_test.cjs — unit tests for rynth/ai/tools/knowledge.js
// (the acpedia/quest knowledge tool, v2 layer). No infra, no network: the
// file provider reads the local sample corpus; everything else is mocked.
//
// Run: node rynth_ai_knowledge_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const SAMPLE = path.join(__dirname, "rynth", "ai", "tools", "knowledge.sample.json");

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "tools", "knowledge.js")).href);
  const { KnowledgeBase, FileKnowledgeProvider, knowledgeAction, registerKnowledge, QUERY_MAX_CHARS } = mod;
  // The frozen v1 module, imported ONLY to prove we never touch it.
  const actionsMod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "actions.js")).href);

  // ---- FileKnowledgeProvider: ranking over inline entries.
  {
    const p = new FileKnowledgeProvider({ entries: [
      { title: "Zeta Golem", text: "z" },
      { title: "Alpha Golem", text: "a", url: "https://acpedia.example/wiki/Alpha_Golem" },
      { title: "Mudball", aliases: ["golem bait"], text: "b" },
      { title: "Aardvark", text: "likes   golem\ncrumbs" },
      { title: "Unrelated", text: "nothing here" },
      null, { text: "no title" }, { title: 42 }, "junk", // malformed rows are skipped, not fatal
    ] });
    const rows = await p.search("golem", 10);
    check("rank: title > alias > body, tie-break by title",
      rows.map((r) => r.title).join(",") === "Alpha Golem,Zeta Golem,Mudball,Aardvark",
      JSON.stringify(rows.map((r) => r.title)));
    check("rank: scores are tiered desc", rows[0].score === rows[1].score
      && rows[1].score > rows[2].score && rows[2].score > rows[3].score,
      JSON.stringify(rows.map((r) => r.score)));
    check("rank: row shape {title, summary, url?, score}",
      rows.every((r) => typeof r.title === "string" && typeof r.summary === "string" && typeof r.score === "number")
      && rows[0].url === "https://acpedia.example/wiki/Alpha_Golem" && !("url" in rows[2]));
    check("rank: summary whitespace collapsed", rows[3].summary === "likes golem crumbs", rows[3].summary);
    check("rank: case-insensitive", JSON.stringify(await p.search("GoLeM", 10)) === JSON.stringify(rows));
    check("rank: default limit 3", (await p.search("golem")).length === 3);
    check("rank: limit 1", (await p.search("golem", 1)).map((r) => r.title).join() === "Alpha Golem");
    check("rank: limit 0 / bad limit -> empty",
      (await p.search("golem", 0)).length === 0 && (await p.search("golem", "x")).length === 0);
    check("rank: blank query -> empty, not everything",
      (await p.search("")).length === 0 && (await p.search("   ")).length === 0
      && (await p.search(null)).length === 0);
    check("rank: no match -> empty", (await p.search("zzz-nope")).length === 0);
  }

  // ---- FileKnowledgeProvider: missing / corrupt file -> empty, never throws.
  {
    const missing = new FileKnowledgeProvider({ path: path.join(__dirname, "no-such-dir", "nope.json") });
    const r1 = await missing.search("olthoi").catch((e) => ({ threw: e }));
    check("file: missing file -> [] without throwing", Array.isArray(r1) && r1.length === 0, String(r1.threw));
    const corrupt = new FileKnowledgeProvider({ path: __filename }); // exists, not JSON
    const r2 = await corrupt.search("olthoi").catch((e) => ({ threw: e }));
    check("file: corrupt file -> [] without throwing", Array.isArray(r2) && r2.length === 0, String(r2.threw));
    const pathless = new FileKnowledgeProvider({});
    check("file: no path, no entries -> []", (await pathless.search("olthoi")).length === 0);
  }

  // ---- FileKnowledgeProvider: sample corpus from disk (lazy fs load).
  {
    const p = new FileKnowledgeProvider({ path: SAMPLE });
    const rows = await p.search("olthoi", 10);
    check("sample: title/alias/body tiers in order",
      rows.map((r) => r.title).join(",") === "Olthoi Soldier,Aerlinthe Recall Quest,Drudge Ravener",
      JSON.stringify(rows.map((r) => r.title)));
    check("sample: unmatched entry excluded", !rows.some((r) => r.title === "Sawato Bandit Cave"));
    check("sample: url carried through", rows[0].url === "https://acpedia.example/wiki/Olthoi_Soldier");
    check("sample: concurrent first searches share one load",
      (await Promise.all([p.search("sawato"), p.search("drudge")])).every((r) => r.length === 1));
  }

  // ---- KnowledgeBase.lookup: delegation + normalization + never-throws.
  {
    const calls = [];
    const provider = {
      async search(query, limit) {
        calls.push({ query, limit });
        return [
          { title: "T1", summary: "S1", url: "u1", score: 9 },
          { title: "T2", score: "bad-score" },        // summary/score normalized
          { title: "", summary: "dropped" }, null, "junk", // dropped
          { title: "T3", summary: "past limit", score: 1 },
        ];
      },
    };
    const kb = new KnowledgeBase({ provider });
    const rows = await kb.lookup("olthoi", { limit: 2 });
    check("kb: delegates query+limit to provider", calls.length === 1
      && calls[0].query === "olthoi" && calls[0].limit === 2, JSON.stringify(calls));
    check("kb: normalizes + enforces limit over provider rows",
      rows.length === 2 && rows[0].title === "T1" && rows[0].url === "u1" && rows[0].score === 9
      && rows[1].title === "T2" && rows[1].summary === "" && rows[1].score === 0 && !("url" in rows[1]),
      JSON.stringify(rows));
    await kb.lookup("q");
    check("kb: default limit 3", calls[1].limit === 3);
    check("kb: no provider -> []", (await new KnowledgeBase({}).lookup("x")).length === 0);
    check("kb: provider without search -> []",
      (await new KnowledgeBase({ provider: {} }).lookup("x")).length === 0);
    const thrower = new KnowledgeBase({ provider: { async search() { throw new Error("db down"); } } });
    const rt = await thrower.lookup("x").catch((e) => ({ threw: e }));
    check("kb: provider throw -> [] without rejecting", Array.isArray(rt) && rt.length === 0, String(rt.threw));
    check("kb: provider returns non-array -> []",
      (await new KnowledgeBase({ provider: { async search() { return "nope"; } } }).lookup("x")).length === 0);
  }

  // ---- knowledgeAction: definition shape + catalog-render compatibility.
  {
    const def = knowledgeAction();
    check("action: type lookup", def.type === "lookup");
    check("action: ACTIONS entry shape (params: {name: desc}, desc)",
      typeof def.desc === "string"
      && def.params && typeof def.params.query === "string" && Object.keys(def.params).length === 1);
    check("action: params document the 200-char cap",
      QUERY_MAX_CHARS === 200 && def.params.query.includes("200"));
    check("action: validate + apply are functions",
      typeof def.validate === "function" && typeof def.apply === "function");
    // The exact renderActionCatalog() rendering (actions.js:41-50) must work
    // on the definition unchanged.
    const line = Object.entries({ lookup: def })
      .map(([type, { params, desc }]) => {
        const p = Object.entries(params).map(([k, d]) => `${k}: ${d}`).join("; ");
        return `${type} {${p}} — ${desc}`;
      })
      .join("\n");
    check("action: renders like a catalog entry", /^lookup \{query: .+\} — .+/.test(line), line);
  }

  // ---- knowledgeAction: validate bounds.
  {
    const v = knowledgeAction().validate;
    check("validate: good query ok", v({ type: "lookup", query: "olthoi soldier" }).ok === true);
    check("validate: exactly 200 chars ok", v({ type: "lookup", query: "q".repeat(200) }).ok === true);
    check("validate: 201 chars rejected", v({ type: "lookup", query: "q".repeat(201) }).ok === false);
    check("validate: missing/empty/non-string query rejected",
      [{ type: "lookup" }, { type: "lookup", query: "" }, { type: "lookup", query: "   " },
       { type: "lookup", query: 7 }].every((a) => v(a).ok === false));
    check("validate: wrong/absent type rejected",
      v({ type: "goto", query: "x" }).ok === false && v({ query: "x" }).ok === false);
    check("validate: non-object rejected", v(null).ok === false && v([]).ok === false);
    check("validate: error strings present",
      typeof v({ type: "lookup", query: "" }).error === "string");
  }

  // ---- knowledgeAction.apply: executeAction-style results, never throws.
  {
    const kb = new KnowledgeBase({ provider: new FileKnowledgeProvider({ path: SAMPLE }) });
    const def = knowledgeAction(kb);
    const bot = {}; // apply never needs a bot surface; must not touch it
    const r = await def.apply(bot, { type: "lookup", query: "  olthoi  " });
    check("apply: happy path {type, ok, result:{query, rows}}",
      r.type === "lookup" && r.ok === true && r.result.query === "olthoi"
      && r.result.rows.length === 3 && r.result.rows[0].title === "Olthoi Soldier",
      JSON.stringify(r));
    const emptyKb = new KnowledgeBase({ provider: new FileKnowledgeProvider({ entries: [] }) });
    const re = await knowledgeAction(emptyKb).apply(bot, { type: "lookup", query: "olthoi" })
      .catch((e) => ({ threw: e }));
    check("apply: empty kb -> ok with rows: [] without throwing",
      !re.threw && re.ok === true && Array.isArray(re.result.rows) && re.result.rows.length === 0,
      JSON.stringify(re));
    const logs = [];
    const rn = await knowledgeAction().apply(bot, { type: "lookup", query: "x" }, { log: (m) => logs.push(m) });
    check("apply: no kb bound -> ok:false unavailable (executeAction shape)",
      rn.ok === false && rn.error === "unavailable" && logs.length === 1, JSON.stringify({ rn, logs }));
    const rb = await knowledgeAction({ lookup() { throw new Error("kb exploded"); } })
      .apply(bot, { type: "lookup", query: "x" }).catch((e) => ({ threw: e }));
    check("apply: kb throw -> ok:false without throwing",
      !rb.threw && rb.ok === false && /kb exploded/.test(rb.error), JSON.stringify(rb));
    const ri = await def.apply(bot, { type: "lookup", query: "q".repeat(201) });
    check("apply: re-validates (201 chars) -> ok:false", ri.ok === false && /200/.test(ri.error));
    const rq = await def.apply(bot, { type: "lookup", query: "no-such-thing-xyz" });
    check("apply: no matches still ok, rows []", rq.ok === true && rq.result.rows.length === 0);
  }

  // ---- knowledgeAction.apply: ctx { kb, journal } plumbing.
  {
    const def = knowledgeAction(); // nothing bound — ctx.kb must win
    const kb = new KnowledgeBase({ provider: new FileKnowledgeProvider({ path: SAMPLE }) });
    const notes = [];
    const journal = { add(kind, text) { notes.push({ kind, text }); } };
    const r = await def.apply({}, { type: "lookup", query: "sawato" }, { kb, journal });
    check("ctx: ctx.kb overrides bound kb", r.ok === true && r.result.rows[0].title === "Sawato Bandit Cave");
    check("ctx: rows journaled as note for the next observation tail",
      notes.length === 1 && notes[0].kind === "note"
      && notes[0].text.includes('lookup "sawato"') && notes[0].text.includes("Sawato Bandit Cave"),
      JSON.stringify(notes));
    const badJournal = { add() { throw new Error("quota"); } };
    const r2 = await def.apply({}, { type: "lookup", query: "sawato" }, { kb, journal: badJournal })
      .catch((e) => ({ threw: e }));
    check("ctx: broken journal never fails the action", !r2.threw && r2.ok === true, String(r2.threw));
    const r3 = await def.apply({}, { type: "lookup", query: "olthoi" }, { kb, limit: 1 });
    check("ctx: limit honored", r3.result.rows.length === 1 && r3.result.rows[0].title === "Olthoi Soldier");
  }

  // ---- registerKnowledge: mutates the PASSED-IN map only.
  {
    const kb = new KnowledgeBase({ provider: new FileKnowledgeProvider({ path: SAMPLE }) });
    const fakeActions = { none: { params: {}, desc: "do nothing this check-in" } };
    const def = registerKnowledge(fakeActions, kb);
    check("register: adds lookup to the passed-in map, keeps existing entries",
      fakeActions.lookup === def && !!fakeActions.none && Object.keys(fakeActions).length === 2);
    const r = await fakeActions.lookup.apply({}, { type: "lookup", query: "drudge" });
    check("register: kb bound through the map entry",
      r.ok === true && r.result.rows[0].title === "Drudge Ravener", JSON.stringify(r));
    check("register: real actions.js ACTIONS untouched (no lookup key)",
      !("lookup" in actionsMod.ACTIONS)
      && Object.keys(actionsMod.ACTIONS).length === 11 // exact v1 list, SPEC §actions
      && !actionsMod.renderActionCatalog().includes("lookup"));
    let threw = null;
    try { registerKnowledge(null, kb); } catch (e) { threw = e; }
    check("register: bad map throws TypeError (integrator-time, not LLM path)",
      threw instanceof TypeError);
    // A copied-ACTIONS map (the documented integrator wiring) also works.
    const merged = { ...actionsMod.ACTIONS };
    registerKnowledge(merged, kb);
    check("register: { ...ACTIONS } copy gains lookup, original still clean",
      "lookup" in merged && !("lookup" in actionsMod.ACTIONS));
  }

  // ---- word-AND fallback tiers (2026-07-17) -------------------------------
  {
    const p = new FileKnowledgeProvider({ entries: [
      { title: "Academy Exit Token", text: "Speak to Jonathan to receive this gem." },
      { title: "Academy Token", text: "Give to Training Master" },
      { title: "Cow", text: "Found near the academy. Drops a token of appreciation." },
    ]});
    const r1 = await p.search("Academy Token", 3);
    check("word-AND: exact still wins", r1[0].title === "Academy Token", JSON.stringify(r1));
    check("word-AND: gapped title second", r1[1] && r1[1].title === "Academy Exit Token" && r1[1].score === 4, JSON.stringify(r1));
    check("word-AND: body tier last", r1[2] && r1[2].title === "Cow" && r1[2].score === 1, JSON.stringify(r1));
    const r2 = await p.search("token", 3);
    check("word-AND: single word does NOT trigger word tiers",
      r2.length === 3 && r2.every((r) => r.score !== 4 && r.score !== 1), JSON.stringify(r2));
    const r3 = await p.search("exit token", 2);
    check("word-AND: phrase-in-title unaffected", r3[0] && r3[0].title === "Academy Exit Token" && r3[0].score === 5, JSON.stringify(r3));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
