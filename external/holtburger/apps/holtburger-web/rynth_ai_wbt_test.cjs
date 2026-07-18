#!/usr/bin/env node
// rynth_ai_wbt_test.cjs — unit tests for rynth/ai/tools/wbt.js (the
// WorldBuilder.Terminal oracle: WbtOracle client, wbt_query / wbt_catalog /
// file_ticket actions) + its extensions.js wiring and the persona preamble.
// No infra: a throwaway in-process HTTP server stands in for the wbt-sidecar.
//
// Run: node rynth_ai_wbt_test.cjs   (exits 1 on any FAIL)

"use strict";
const http = require("node:http");
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

function makeBot() {
  return {
    host: {
      TryGetPlayerPose: () => ({ objCellId: 0xa9b40015, x: 42.1, y: 77.9, z: 62.0 }),
      TryGetPlayerName: () => "Testchar",
    },
  };
}

// Mock sidecar: /health, /catalog (one denied row), /command (echo, "boom"
// fails), /ticket (captures body).
function startMockSidecar() {
  const seen = { tickets: [], commands: [] };
  const server = http.createServer((req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/health") return send(200, { ok: true, ready: true });
      if (url.pathname === "/catalog") {
        const rows = [
          { name: "describe-landblock", args: "lbX, lbY", description: "Living Atlas description", allowed: true },
          { name: "spell-list", args: "source?", description: "Lists spells", allowed: true },
          { name: "paint", args: "x, y", description: "Paint terrain", allowed: false },
        ];
        const f = (url.searchParams.get("filter") || "").toLowerCase();
        return send(200, { ok: true, commands: rows.filter((r) => !f || r.name.includes(f)) });
      }
      if (url.pathname === "/command") {
        const cmd = JSON.parse(body);
        seen.commands.push(cmd);
        if (cmd.command === "boom") return send(502, { ok: false, error: "WBT exploded" });
        return send(200, { ok: true, response: { success: true, command: cmd.command, echo: cmd, blob: "Z".repeat(5000) } });
      }
      if (url.pathname === "/ticket") {
        const t = JSON.parse(body);
        seen.tickets.push(t);
        return send(200, { ok: true, id: "tick-1", file: "/dev/null" });
      }
      return send(404, { ok: false, error: "unknown" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, endpoint: `http://127.0.0.1:${server.address().port}` }));
  });
}

(async () => {
  const modUrl = (p) => pathToFileURL(path.join(__dirname, p)).href;
  const { WbtOracle, wbtActions, registerWbt, compactJson } = await import(modUrl("rynth/ai/tools/wbt.js"));
  const { composeAiExtensions, renderPersonaPreamble } = await import(modUrl("rynth/ai/extensions.js"));
  const { DEFAULT_SYSTEM_PROMPT } = await import(modUrl("rynth/ai/director.js"));

  const { server, seen, endpoint } = await startMockSidecar();
  const oracle = new WbtOracle({ endpoint });

  // --- compactJson --------------------------------------------------------
  {
    const s = compactJson({ a: "x".repeat(1000), b: 1 });
    check("compactJson caps long strings", s.length < 500 && s.includes('"b":1'));
    const circ = {}; circ.self = circ;
    check("compactJson never throws", compactJson(circ) === "(unserializable)");
  }

  // --- WbtOracle ----------------------------------------------------------
  {
    const h = await oracle.health();
    check("oracle.health ok", h.ok === true && h.ready === true);
    const c = await oracle.catalog("spell");
    check("oracle.catalog filters", c.ok === true && c.commands.length === 1 && c.commands[0].name === "spell-list");
    const q = await oracle.query({ command: "info" });
    check("oracle.query ok", q.ok === true && q.response.command === "info");
    const bad = await new WbtOracle({ endpoint: "http://127.0.0.1:1" }).query({ command: "info" });
    check("oracle unreachable degrades", bad.ok === false && /unreachable/.test(bad.error));
  }

  // --- action shapes ------------------------------------------------------
  const [queryDef, catalogDef, ticketDef] = wbtActions(oracle);
  {
    check("def types", queryDef.type === "wbt_query" && catalogDef.type === "wbt_catalog" && ticketDef.type === "file_ticket");
    for (const def of [queryDef, catalogDef, ticketDef]) {
      check(`${def.type} rejects non-object`, def.validate(null).ok === false);
      check(`${def.type} rejects wrong type`, def.validate({ type: "nope" }).ok === false);
    }
    check("wbt_query rejects empty command", queryDef.validate({ type: "wbt_query", command: " " }).ok === false);
    check("wbt_query rejects array args", queryDef.validate({ type: "wbt_query", command: "info", args: [] }).ok === false);
    check("wbt_query accepts args object", queryDef.validate({ type: "wbt_query", command: "info", args: { lbX: 1 } }).ok === true);
    check("wbt_catalog accepts bare", catalogDef.validate({ type: "wbt_catalog" }).ok === true);
    check("wbt_catalog rejects non-string filter", catalogDef.validate({ type: "wbt_catalog", filter: 3 }).ok === false);
    check("file_ticket needs title+body", ticketDef.validate({ type: "file_ticket", title: "t" }).ok === false);
    check("file_ticket rejects bad severity", ticketDef.validate({ type: "file_ticket", title: "t", body: "b", severity: "meh" }).ok === false);
    check("file_ticket accepts full", ticketDef.validate({ type: "file_ticket", title: "t", body: "b", severity: "high" }).ok === true);
  }

  // --- wbt_query apply ----------------------------------------------------
  {
    const journal = makeJournal();
    const r = await queryDef.apply(makeBot(), { type: "wbt_query", command: "describe-landblock", args: { lbX: 42, lbY: 33 } }, { journal });
    check("wbt_query ok", r.ok === true && r.result.command === "describe-landblock");
    const sent = seen.commands.find((c) => c.command === "describe-landblock");
    check("wbt_query flattens args", sent && sent.lbX === 42 && sent.lbY === 33);
    check("wbt_query journals clipped note", journal.entries.length === 1
      && journal.entries[0].text.startsWith("wbt describe-landblock:")
      && journal.entries[0].text.length <= 810);
    const rf = await queryDef.apply(makeBot(), { type: "wbt_query", command: "boom" }, { journal });
    check("wbt_query failure degrades", rf.ok === false && /exploded/.test(rf.error));
    check("wbt_query failure journaled", journal.entries.some((e) => /FAILED WBT exploded/.test(e.text)));
    const inv = await queryDef.apply(makeBot(), { type: "wbt_query" }, { journal });
    check("wbt_query apply validates", inv.ok === false);
  }

  // --- wbt_catalog apply --------------------------------------------------
  {
    const journal = makeJournal();
    const r = await catalogDef.apply(makeBot(), { type: "wbt_catalog" }, { journal });
    check("wbt_catalog ok, allowed-only", r.ok === true && r.result.total === 2 && !r.result.catalog.includes("paint"));
    check("wbt_catalog journals names", journal.entries[0].text.includes("describe-landblock") && journal.entries[0].text.includes("spell-list"));
  }

  // --- file_ticket apply --------------------------------------------------
  {
    const journal = makeJournal();
    const r = await ticketDef.apply(makeBot(), { type: "file_ticket", title: "NPC sells nothing", body: "Vendor at Holtburg has an empty buy list.", severity: "high" }, { journal });
    check("file_ticket ok", r.ok === true && r.result.id === "tick-1");
    const t = seen.tickets[0];
    check("file_ticket attaches character+position", t.character === "Testchar" && t.position && t.position.objCellId === 0xa9b40015);
    check("file_ticket journaled", journal.entries[0].text.includes("ticket filed (tick-1)"));
    const hostless = await ticketDef.apply({}, { type: "file_ticket", title: "t", body: "b" }, { journal });
    check("file_ticket survives hostless bot", hostless.ok === true && seen.tickets[1].position === null);
    // dedupe: same normalized title -> rejected, tracker untouched
    const before = seen.tickets.length;
    const dup = await ticketDef.apply(makeBot(), { type: "file_ticket", title: "NPC Sells NOTHING!", body: "again" }, { journal });
    check("file_ticket dedupes by title", dup.ok === false && /already filed/.test(dup.error) && seen.tickets.length === before, dup.error);
    const fresh = await ticketDef.apply(makeBot(), { type: "file_ticket", title: "Different bug entirely", body: "b" }, { journal });
    check("file_ticket new title still files", fresh.ok === true && seen.tickets.length === before + 1);
  }

  // --- registerWbt guard --------------------------------------------------
  {
    let threw = false;
    try { registerWbt(null, oracle); } catch { threw = true; }
    check("registerWbt throws on bad map", threw);
    const map = {};
    registerWbt(map, oracle);
    check("registerWbt adds all three", !!map.wbt_query && !!map.wbt_catalog && !!map.file_ticket);
  }

  // --- extensions.js wiring -----------------------------------------------
  {
    const ext = composeAiExtensions(makeBot(), { journal: makeJournal(), config: { knowledge: false, dungeonNav: false, wbt: { oracle } } });
    check("compose: wbt default-on with injected oracle", ext.wbt === oracle && !!ext.extActions.wbt_query);
    check("compose: prompt advertises wbt actions", ext.directorDeps.systemPrompt.includes("wbt_query {")
      && ext.directorDeps.systemPrompt.includes("file_ticket {"));
    check("compose: validate routes to wbt def", ext.directorDeps.validate({ type: "wbt_query", command: "info" }).ok === true
      && ext.directorDeps.validate({ type: "wbt_query", command: "" }).ok === false);
    const journal2 = makeJournal();
    const ext2 = composeAiExtensions(makeBot(), { journal: journal2, config: { knowledge: false, dungeonNav: false, wbt: { endpoint } } });
    const results = await ext2.directorDeps.execute(makeBot(), [{ type: "wbt_query", command: "info" }]);
    check("compose: execute runs wbt action", results.length === 1 && results[0].ok === true);
    check("compose: execute journaled wbt note", journal2.entries.some((e) => e.text.startsWith("wbt info:")));
    const down = composeAiExtensions(makeBot(), { journal: makeJournal(), config: { knowledge: false, dungeonNav: false, wbt: { endpoint: "http://127.0.0.1:1" } } });
    const dr = await down.directorDeps.execute(makeBot(), [{ type: "wbt_query", command: "info" }]);
    check("compose: down sidecar degrades to ok:false", dr.length === 1 && dr[0].ok === false && /unreachable/.test(dr[0].error));
  }

  // --- no-hints mode (query: false -> tickets only) -----------------------
  {
    const defs = wbtActions(oracle, { query: false });
    check("no-hints: only file_ticket registered", defs.length === 1 && defs[0].type === "file_ticket");
    const map = {};
    registerWbt(map, oracle, { query: false });
    check("no-hints: map lacks oracle verbs", !map.wbt_query && !map.wbt_catalog && !!map.file_ticket);
    const ext = composeAiExtensions(makeBot(), {
      journal: makeJournal(),
      config: { knowledge: false, dungeonNav: false, wbt: { oracle, query: false } },
    });
    check(
      "no-hints: compose drops wbt_query/wbt_catalog, keeps file_ticket",
      !ext.extActions.wbt_query && !ext.extActions.wbt_catalog && !!ext.extActions.file_ticket
    );
    const sp = ext.directorDeps.systemPrompt;
    check("no-hints: catalog omits oracle verbs", !sp.includes("wbt_query") && !sp.includes("wbt_catalog"));
    check("no-hints: PLAYTESTER DISCIPLINE still present", sp.includes("PLAYTESTER DISCIPLINE"));
    const dflt = composeAiExtensions(makeBot(), {
      journal: makeJournal(),
      config: { knowledge: false, dungeonNav: false, wbt: { oracle } },
    });
    check("no-hints: default stays all-on", !!dflt.extActions.wbt_query && !!dflt.extActions.wbt_catalog);
  }

  // --- persona ------------------------------------------------------------
  {
    check("persona: absent -> empty", renderPersonaPreamble(undefined) === "" && renderPersonaPreamble(false) === "" && renderPersonaPreamble({}) === "");
    const p = renderPersonaPreamble({ name: "Brakis", background: "A fresh arrival with 10000 pyreals.", goals: "Reach level 10; run the starter quests." });
    check("persona: renders identity", p.startsWith("WHO YOU ARE") && p.includes("Brakis") && p.includes("10000 pyreals") && p.includes("file_ticket"));
    const ext = composeAiExtensions(makeBot(), {
      journal: makeJournal(),
      config: { knowledge: false, dungeonNav: false, wbt: { oracle }, persona: { name: "Brakis" } },
    });
    const sp = ext.directorDeps.systemPrompt;
    check("persona: prepended before v1 base", sp.startsWith("WHO YOU ARE") && sp.indexOf("WHO YOU ARE") < sp.indexOf(DEFAULT_SYSTEM_PROMPT.slice(0, 40)));
    check("persona: EXTRA ACTIONS still appended", sp.indexOf("EXTRA ACTIONS") > sp.indexOf(DEFAULT_SYSTEM_PROMPT.slice(0, 40)));
    const noP = composeAiExtensions(makeBot(), { journal: makeJournal(), config: { knowledge: false, dungeonNav: false, wbt: { oracle } } });
    check("persona: absent config leaves prompt v1-based", noP.directorDeps.systemPrompt.startsWith(DEFAULT_SYSTEM_PROMPT.slice(0, 40)));
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
