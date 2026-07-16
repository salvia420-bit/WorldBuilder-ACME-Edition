#!/usr/bin/env node
// rynth_ai_journal_test.cjs — unit tests for rynth/ai/journal.js (AiJournal).
// No infra, no network: memory mode is exercised first, then a hand-rolled
// localStorage stub is installed on globalThis for the persistence half.
//
// Run: node rynth_ai_journal_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// Same local-time formatting journal.js uses, so expectations are TZ-proof.
function hhmm(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

(async () => {
  const { AiJournal } = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "journal.js")).href);

  // ---- memory mode: CRUD + cap rotation (no global localStorage installed yet) ----
  try { delete globalThis.localStorage; } catch { /* ignore */ }
  check("memory mode precondition", typeof globalThis.localStorage === "undefined",
    "could not remove ambient localStorage; memory-mode half is invalid");

  {
    const j = new AiJournal({ maxEntries: 5 });
    check("starts empty", j.tail().length === 0);
    j.add("plan", "first");
    const e = j.tail(1)[0];
    check("entry shape", !!e && e.kind === "plan" && e.text === "first" && Number.isFinite(e.t),
      JSON.stringify(e));
    check("add stamps fresh t", Math.abs(Date.now() - e.t) < 5000, `t=${e.t}`);
    for (let i = 2; i <= 7; i++) j.add("note", `e${i}`);
    check("cap rotation drops oldest", j.tail(99).length === 5 && j.tail(99)[0].text === "e3",
      JSON.stringify(j.tail(99).map((x) => x.text)));
    check("tail newest-last", j.tail(2).map((x) => x.text).join(",") === "e6,e7");
    check("tail(0) empty", j.tail(0).length === 0);
    const copy = j.tail(1)[0];
    copy.text = "mutated";
    check("tail returns copies", j.tail(1)[0].text === "e7");
    j.clear();
    check("clear empties", j.tail().length === 0 && j.export() === "[]");
  }

  // ---- kind coercion ----
  {
    const j = new AiJournal({});
    for (const k of ["plan", "result", "note", "error", "budget"]) j.add(k, k);
    j.add("bogus", "x");
    j.add(undefined, "y");
    j.add(42, "z");
    const kinds = j.tail(99).map((e) => e.kind);
    check("valid kinds kept", kinds.slice(0, 5).join(",") === "plan,result,note,error,budget",
      kinds.join(","));
    check("unknown kinds coerce to note", kinds.slice(5).every((k) => k === "note"), kinds.join(","));
  }

  // ---- renderTail: format, ordering, char budget ----
  {
    const j = new AiJournal({ maxEntries: 50 });
    const t0 = 1752600000000; // fixed stamps -> deterministic HH:MM via hhmm()
    const fixture = [
      { t: t0, kind: "plan", text: "alpha" },
      { t: t0 + 61000, kind: "result", text: "bravo bravo" },
      { t: t0 + 122000, kind: "error", text: "charlie\nhas\nnewlines" },
    ];
    check("import fixture", j.import(JSON.stringify(fixture)) === true);
    const full = j.renderTail(10, 2000);
    const lines = full.split("\n");
    check("renderTail line count", lines.length === 3, full);
    check("renderTail format", lines[0] === `${hhmm(t0)} plan: alpha`, lines[0]);
    check("renderTail newest last",
      lines[2].startsWith(`${hhmm(t0 + 122000)} error:`) && lines[1].includes("result: bravo"),
      full);
    check("renderTail collapses newlines", lines[2].endsWith("charlie has newlines"), lines[2]);
    // Budget that fits exactly the newest two lines -> oldest dropped first.
    const two = lines[2].length + 1 + lines[1].length;
    const r2 = j.renderTail(10, two);
    check("budget drops oldest first", r2 === `${lines[1]}\n${lines[2]}`, r2);
    // Budget smaller than the newest line -> truncated newest, never over budget.
    const r1 = j.renderTail(10, 8);
    check("tiny budget truncates newest", r1.length <= 8 && lines[2].startsWith(r1),
      JSON.stringify(r1));
    check("renderTail(1) only newest", j.renderTail(1, 2000) === lines[2]);
    check("renderTail empty journal", new AiJournal({}).renderTail() === "");
  }

  // ---- export / import round-trip + malicious import rejected ----
  {
    const a = new AiJournal({});
    a.add("plan", "p1");
    a.add("result", "r1");
    const blob = a.export();
    check("export is JSON array", Array.isArray(JSON.parse(blob)) && JSON.parse(blob).length === 2, blob);
    const b = new AiJournal({});
    check("import round-trip ok", b.import(blob) === true);
    check("round-trip preserves entries",
      JSON.stringify(b.tail(99)) === JSON.stringify(a.tail(99)),
      b.export());

    check("import replaces state",
      b.import(JSON.stringify([{ t: 1, kind: "note", text: "only" }])) === true
        && b.tail(99).length === 1 && b.tail(99)[0].text === "only");

    const before = b.export();
    const bads = [
      42,                                            // non-string input
      "not json",
      '{"a":1}',                                     // non-array
      "[null]",
      '[{"kind":"note","text":"x"}]',                // missing t
      '[{"t":"soon","kind":"note","text":"x"}]',     // t not a number
      '[{"t":1,"kind":5,"text":"x"}]',               // kind not a string
      '[{"t":1,"kind":"note","text":5}]',            // text not a string
      '[{"t":1,"kind":"note","text":"ok"},"evil"]',  // one bad entry poisons the batch
    ];
    for (const bad of bads) {
      check(`import rejects ${JSON.stringify(bad).slice(0, 44)}`,
        b.import(bad) === false && b.export() === before);
    }

    check("import strips extra keys + coerces kind",
      b.import('[{"t":1,"kind":"hax","text":"x","__proto__":{"polluted":1},"admin":true}]') === true
        && Object.keys(b.tail(1)[0]).sort().join(",") === "kind,t,text"
        && b.tail(1)[0].kind === "note"
        && !("polluted" in {}),
      b.export());

    const small = new AiJournal({ maxEntries: 3 });
    const ten = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ t: i, kind: "note", text: `n${i}` })));
    check("import caps to maxEntries (keeps newest)",
      small.import(ten) === true && small.tail(99).map((e) => e.text).join(",") === "n7,n8,n9",
      small.export());
  }

  // ---- localStorage shim: persist / reload / corruption / quota ----
  {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    };

    const KEY = "test_ai_journal";
    const a = new AiJournal({ storageKey: KEY, maxEntries: 10 });
    a.add("plan", "persist-me");
    a.add("note", "me-too");
    check("add persists", JSON.parse(store.get(KEY) || "[]").length === 2, store.get(KEY));

    const b = new AiJournal({ storageKey: KEY, maxEntries: 10 });
    check("reload restores", b.tail(99).map((e) => e.text).join(",") === "persist-me,me-too",
      b.export());

    b.clear();
    check("clear persists", store.get(KEY) === "[]", store.get(KEY));
    check("reload after clear", new AiJournal({ storageKey: KEY }).tail(99).length === 0);

    store.set("corrupt_key", "{{{ not json");
    let corrupt = null, threw = false;
    try { corrupt = new AiJournal({ storageKey: "corrupt_key" }); } catch (e) { threw = true; }
    check("corrupt stored JSON tolerated", !threw && corrupt.tail(99).length === 0);
    corrupt.add("note", "still works");
    check("corrupt store overwritten on add",
      JSON.parse(store.get("corrupt_key")).length === 1, store.get("corrupt_key"));

    store.set("shape_key", '[{"t":"bad-shape"}]');
    check("bad-shape store ignored", new AiJournal({ storageKey: "shape_key" }).tail(99).length === 0);

    store.set("long_key", JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({ t: i, kind: "note", text: `s${i}` }))));
    const long = new AiJournal({ storageKey: "long_key", maxEntries: 4 });
    check("load caps to maxEntries", long.tail(99).map((e) => e.text).join(",") === "s5,s6,s7,s8",
      long.export());

    // Quota: setItem throws -> add()/clear() must not throw; memory keeps working.
    globalThis.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    let quotaThrew = false;
    const q = new AiJournal({ storageKey: "quota_key" });
    try { q.add("note", "over quota"); q.clear(); q.add("plan", "after"); } catch (e) { quotaThrew = true; }
    check("quota throw tolerated", !quotaThrew && q.tail(99).length === 1 && q.tail(1)[0].text === "after",
      q.export());

    // getItem throwing on construct is also tolerated (storage access denied).
    globalThis.localStorage.getItem = () => { throw new Error("denied"); };
    let getThrew = false;
    try { new AiJournal({ storageKey: "denied_key" }); } catch (e) { getThrew = true; }
    check("getItem throw tolerated", !getThrew);

    delete globalThis.localStorage;
  }

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
