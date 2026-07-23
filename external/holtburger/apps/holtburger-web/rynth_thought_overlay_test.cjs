#!/usr/bin/env node
// rynth_thought_overlay_test.cjs — direct-import unit tests for
// rynth/ai/thought_overlay.js (owed follow-up, HANDOFF-remediation-2026-07-23
// line 91: "thought_overlay.js has no direct-import coverage"). The module is
// DOM-side-effecting, but mountThoughtOverlay is dependency-injected: it takes
// a duck-typed `journal` and a `doc` (defaulting to globalThis.document), and
// drives reveal via global setInterval — all three are stubbable node-only.
// We inject a fake DOM + fake journal, capture the two interval callbacks by
// overriding globalThis.setInterval, and drive them by hand to assert the
// poll/reveal/skip/unmount behaviour deterministically. No infra/browser/wasm.
//
// Run: node rynth_thought_overlay_test.cjs   (exits 1 on any FAIL)
// Auto-discovered + run by rynth_test_all_node.cjs (rynth_*_test.cjs glob).
"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ── minimal fake DOM element (only the surface thought_overlay.js touches) ──
function makeEl(tag) {
  return {
    tag, id: "", textContent: "", scrollTop: 0, scrollHeight: 100,
    style: {}, _attrs: {}, children: [], _removed: false,
    setAttribute(k, v) { this._attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    remove() { this._removed = true; },
  };
}
function makeDoc() {
  const body = makeEl("body");
  return { body, createElement: (t) => makeEl(t) };
}
// Journal closes over a live array so tests can push new entries between polls.
function makeJournal(entries) { return { tail: (n) => entries.slice(-n) }; }

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "thought_overlay.js")).href);
  const mountThoughtOverlay = mod.mountThoughtOverlay || mod.default;
  check("exports mountThoughtOverlay", typeof mountThoughtOverlay === "function");

  // ── fake timers: capture the poll + reveal callbacks instead of scheduling ──
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let timers = [];
  globalThis.setInterval = (cb, ms) => { const t = { cb, ms, cleared: false }; timers.push(t); return t; };
  globalThis.clearInterval = (id) => { if (id && typeof id === "object") id.cleared = true; };

  try {
    // 1. no-op guard: missing doc, missing journal, or a journal without tail().
    {
      const a = mountThoughtOverlay(makeJournal([]), { doc: null });
      const b = mountThoughtOverlay(null, { doc: makeDoc() });
      const c = mountThoughtOverlay({}, { doc: makeDoc() }); // no .tail
      const shapesOk = [a, b, c].every((h) => h && typeof h.unmount === "function");
      let threw = false;
      try { a.unmount(); b.unmount(); c.unmount(); } catch { threw = true; }
      check("no-op guard returns a safe {unmount} and mounts nothing",
        shapesOk && !threw && timers.length === 0, `timers=${timers.length}`);
    }

    // 2. valid mount attaches one root to doc.body and schedules two timers.
    {
      timers = [];
      const doc = makeDoc();
      const handle = mountThoughtOverlay(makeJournal([]), { doc, intervalMinutes: 5 });
      const root = doc.body.children[0];
      const head = root && root.children[0];
      check("mount attaches #hb-thought-overlay with a DIRECTOR head + 2 timers",
        doc.body.children.length === 1 && root.id === "hb-thought-overlay" &&
        head && head.textContent === "DIRECTOR" && timers.length === 2,
        JSON.stringify({ kids: doc.body.children.length, id: root && root.id, timers: timers.length }));
      handle.unmount();
    }

    // 3. poll picks up the newest plan; reveal renders it char-by-char to full.
    {
      timers = [];
      const doc = makeDoc();
      const entries = [
        { kind: "chat", t: 1, text: "hi there" },
        { kind: "plan", t: 2, text: "Explore the ruins" },
      ];
      mountThoughtOverlay(makeJournal(entries), { doc, intervalMinutes: 5 });
      const root = doc.body.children[0];
      const bodyEl = root.children[1];
      const pollCb = timers[0].cb, revealCb = timers[1].cb;

      pollCb(); // ingest newest plan
      check("poll: newest plan makes the overlay visible",
        root.style.display === "block" && root.style.opacity === "1", JSON.stringify(root.style));

      revealCb(); // one reveal tick -> a strict, non-empty prefix
      const first = bodyEl.textContent;
      check("reveal: first tick shows a non-empty prefix, not the whole thought",
        first.length > 0 && first.length < "Explore the ruins".length &&
        "Explore the ruins".startsWith(first), JSON.stringify(first));

      for (let i = 0; i < 40; i++) revealCb(); // drive to completion
      check("reveal: converges to the full thought and dims when done",
        bodyEl.textContent === "Explore the ruins" && root.style.opacity === "0.55",
        JSON.stringify({ text: bodyEl.textContent, op: root.style.opacity }));
    }

    // 4. empty-analysis plans (text starting with "|") are skipped.
    {
      timers = [];
      const doc = makeDoc();
      mountThoughtOverlay(makeJournal([{ kind: "plan", t: 1, text: "| actions: none | next: -m" }]),
        { doc, intervalMinutes: 5 });
      const root = doc.body.children[0];
      const bodyEl = root.children[1];
      timers[0].cb(); timers[1].cb();
      check("skips empty-analysis plan (leading '|')",
        bodyEl.textContent === "" && root.style.display !== "block", JSON.stringify(root.style));
    }

    // 5. non-plan journal kinds never reveal anything.
    {
      timers = [];
      const doc = makeDoc();
      mountThoughtOverlay(makeJournal([{ kind: "observation", t: 1, text: "saw a rat" }]),
        { doc, intervalMinutes: 5 });
      const root = doc.body.children[0];
      const bodyEl = root.children[1];
      timers[0].cb(); timers[1].cb();
      check("ignores non-plan kinds", bodyEl.textContent === "", JSON.stringify(bodyEl.textContent));
    }

    // 6. lastT gate: a re-poll with no strictly-newer plan does not re-show.
    {
      timers = [];
      const doc = makeDoc();
      const entries = [{ kind: "plan", t: 2, text: "AAAA" }];
      mountThoughtOverlay(makeJournal(entries), { doc, intervalMinutes: 5 });
      const root = doc.body.children[0];
      const bodyEl = root.children[1];
      const pollCb = timers[0].cb, revealCb = timers[1].cb;
      pollCb();
      for (let i = 0; i < 20; i++) revealCb();
      const shown = bodyEl.textContent;
      entries.push({ kind: "plan", t: 2, text: "BBBB" }); // same t, not > lastT
      pollCb();
      for (let i = 0; i < 20; i++) revealCb();
      check("lastT gate: same-timestamp plan does not replace the shown thought",
        shown === "AAAA" && bodyEl.textContent === "AAAA", JSON.stringify(bodyEl.textContent));
    }

    // 7. unmount clears both timers and removes the root node.
    {
      timers = [];
      const doc = makeDoc();
      const handle = mountThoughtOverlay(makeJournal([]), { doc, intervalMinutes: 5 });
      const root = doc.body.children[0];
      handle.unmount();
      check("unmount clears both intervals and removes the root",
        timers.every((t) => t.cleared) && root._removed === true,
        JSON.stringify({ cleared: timers.map((t) => t.cleared), removed: root._removed }));
    }
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }

  console.log(`\nthought_overlay: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
