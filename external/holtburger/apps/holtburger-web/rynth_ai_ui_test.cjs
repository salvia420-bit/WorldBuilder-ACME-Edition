#!/usr/bin/env node
// rynth_ai_ui_test.cjs — unit tests for rynth/ai/ui.js (SPEC §ui). No infra,
// no network, no jsdom: a hand-rolled document stub covering exactly the
// narrow DOM surface ui.js is allowed to use, plus captured fake
// setInterval/clearInterval so the 5 s refresh and destroy() are assertable.
//
// Run: node rynth_ai_ui_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

// ---- hand-rolled DOM stub ----
function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parent: null,
    style: {},          // ui.js only sets style.cssText
    attrs: {},
    _listeners: {},
    textContent: "",
    value: "",
    type: "",
    placeholder: "",
    checked: false,
    id: "",
    appendChild(child) { child.parent = el; el.children.push(child); return child; },
    remove() {
      if (!el.parent) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener(type, fn) { (el._listeners[type] ||= []).push(fn); },
    setAttribute(k, v) { el.attrs[k] = String(v); },
  };
  return el;
}
function makeDoc() {
  return { createElement: makeEl, body: makeEl("body"), documentElement: makeEl("html") };
}
function* walk(el) { yield el; for (const c of el.children) yield* walk(c); }
function find(root, pred) { for (const e of walk(root)) if (pred(e)) return e; return null; }
function findAll(root, pred) { const out = []; for (const e of walk(root)) if (pred(e)) out.push(e); return out; }
function fire(el, type) { for (const fn of el._listeners[type] || []) fn({ type, target: el }); }

(async () => {
  // Fake timers installed BEFORE mount — ui.js resolves setInterval at call time.
  const intervals = new Map();
  let nextTimerId = 1;
  const realSI = global.setInterval, realCI = global.clearInterval;
  global.setInterval = (fn, ms) => { const id = nextTimerId++; intervals.set(id, { fn, ms }); return id; };
  global.clearInterval = (id) => { intervals.delete(id); };
  const tickAll = () => { for (const { fn } of intervals.values()) fn(); };

  const doc = makeDoc();
  global.document = doc;

  const ui = await import(pathToFileURL(path.join(__dirname, "rynth", "ai", "ui.js")).href);

  // ---- duck-typed fakes (SPEC amendment: no llm_client import; client via param) ----
  const saved = []; let cleared = 0;
  const client = {
    loadKey: () => "sk-or-test-XYZ",
    saveKey: (k) => saved.push(k),
    clearKey: () => { cleared++; },
  };
  const dcalls = { start: 0, stop: 0, checkNow: 0 };
  const journalEntries = [
    { t: 1, kind: "plan", text: "hunt drudges near LS" },
    { t: 2, kind: "result", text: "goto ok" },
    { t: 3, kind: "note", text: "low mana area" },
  ];
  const director = {
    _enabled: false,
    intervalMinutes: 5,
    client: { model: "anthropic/claude-haiku-4.5" },
    journal: { tail: (n) => journalEntries.slice(-n) },
    start() { dcalls.start++; this._enabled = true; },
    stop() { dcalls.stop++; this._enabled = false; },
    checkNow() { dcalls.checkNow++; return Promise.resolve({ plan: { actions: [] }, results: [] }); },
    get status() {
      return {
        enabled: this._enabled, running: false,
        lastCheckAt: 0, nextCheckAt: Date.now() + 60_000,
        calls: 7, consecutiveErrors: 0, lastSummary: "grinding fine",
        spend: { calls: 7, promptTokens: 10, completionTokens: 5, errors: 0 },
      };
    },
  };

  // ---- mount: element tree ----
  const panel = ui.mountAiPanel(director, { client });
  check("mount returns el+destroy", !!panel && !!panel.el && typeof panel.destroy === "function");
  check("root appended to document.body", doc.body.children.includes(panel.el));
  const rootCss = String(panel.el.style.cssText || "");
  check("root fixed bottom-right ~280px",
    /position:fixed/.test(rootCss) && /bottom/.test(rootCss) && /right/.test(rootCss) && /280px/.test(rootCss),
    rootCss.slice(0, 120));

  const keyInput = find(panel.el, (e) => e.tagName === "INPUT" && e.type === "password");
  check("masked key input present", !!keyInput);
  check("key prefilled from client.loadKey", !!keyInput && keyInput.value === "sk-or-test-XYZ");

  const buttons = findAll(panel.el, (e) => e.tagName === "BUTTON");
  const btnSave = buttons.find((b) => /save/i.test(b.textContent));
  const btnClear = buttons.find((b) => /clear/i.test(b.textContent));
  const btnNow = buttons.find((b) => /check/i.test(b.textContent));
  check("Save/Clear/Check-now buttons present", !!(btnSave && btnClear && btnNow),
    buttons.map((b) => b.textContent).join(","));

  const modelInput = find(panel.el, (e) => e.tagName === "INPUT" && e.type === "text");
  check("model input prefilled from director.client.model",
    !!modelInput && modelInput.value === "anthropic/claude-haiku-4.5");
  const datalist = find(panel.el, (e) => e.tagName === "DATALIST");
  check("datalist of model ids wired to input",
    !!datalist && datalist.children.length >= 2 && !!datalist.id
      && !!modelInput && modelInput.attrs.list === datalist.id);

  const intervalInput = find(panel.el, (e) => e.tagName === "INPUT" && e.type === "number");
  check("interval input prefilled", !!intervalInput && intervalInput.value === "5");

  const enableCb = find(panel.el, (e) => e.tagName === "INPUT" && e.type === "checkbox");
  check("enable checkbox present, off initially", !!enableCb && enableCb.checked === false);

  // ---- key save/clear wiring ----
  keyInput.value = "sk-or-NEW";
  fire(btnSave, "click");
  check("Save calls client.saveKey(input value)", saved.length === 1 && saved[0] === "sk-or-NEW",
    JSON.stringify(saved));
  fire(btnClear, "click");
  check("Clear calls client.clearKey + empties input", cleared === 1 && keyInput.value === "");

  // ---- enable toggles start/stop ----
  enableCb.checked = true; fire(enableCb, "change");
  check("enable -> director.start()", dcalls.start === 1 && dcalls.stop === 0);
  enableCb.checked = false; fire(enableCb, "change");
  check("disable -> director.stop()", dcalls.stop === 1);

  // ---- Check now: fire-and-forget ----
  fire(btnNow, "click");
  await Promise.resolve();
  check("Check now -> director.checkNow()", dcalls.checkNow === 1);
  let unhandled = null;
  const onUR = (e) => { unhandled = e; };
  process.on("unhandledRejection", onUR);
  director.checkNow = () => { dcalls.checkNow++; return Promise.reject(new Error("boom")); };
  fire(btnNow, "click");
  await new Promise((r) => setImmediate(r));
  process.removeListener("unhandledRejection", onUR);
  check("rejected checkNow swallowed (fire-and-forget)", dcalls.checkNow === 2 && unhandled === null,
    unhandled ? String(unhandled) : "");

  // ---- 5 s status refresh ----
  check("exactly one 5000 ms interval registered",
    intervals.size === 1 && [...intervals.values()][0].ms === 5000,
    `size=${intervals.size}`);
  director._enabled = true; // flip behind the panel's back; tick must resync
  tickAll();
  check("status line renders director.status",
    !!find(panel.el, (e) => String(e.textContent).includes("grinding fine")
      && String(e.textContent).includes("calls=7")));
  check("tick resyncs enable checkbox from status", enableCb.checked === true);
  check("journal last-3 lines rendered",
    !!find(panel.el, (e) => String(e.textContent).includes("[note] low mana area")
      && String(e.textContent).includes("hunt drudges")));

  // ---- model / interval edits write back (duck-typed) ----
  modelInput.value = "openai/gpt-4o-mini"; fire(modelInput, "change");
  check("model edit -> director.client.model", director.client.model === "openai/gpt-4o-mini");
  intervalInput.value = "99"; fire(intervalInput, "change");
  check("interval edit clamped to 30 (SPEC 1..30)",
    intervalInput.value === "30" && director.intervalMinutes === 30);
  intervalInput.value = "0"; fire(intervalInput, "change");
  check("interval edit clamped up to 1",
    intervalInput.value === "1" && director.intervalMinutes === 1);

  // ---- destroy ----
  panel.destroy();
  check("destroy clears the interval", intervals.size === 0);
  check("destroy removes root from body", !doc.body.children.includes(panel.el));
  panel.destroy();
  check("double destroy safe", true);

  // ---- repeat mount / double mount ----
  const p2 = ui.mountAiPanel(director, { client });
  check("re-mount after destroy works", doc.body.children.includes(p2.el) && intervals.size === 1);
  const p3 = ui.mountAiPanel(director, { client });
  check("two panels coexist", doc.body.children.length === 2 && intervals.size === 2);
  p2.destroy(); p3.destroy();
  check("both destroyed cleanly", doc.body.children.length === 0 && intervals.size === 0);

  // ---- degraded: no director / no client (must never throw) ----
  const p4 = ui.mountAiPanel(null, {});
  check("mounts with null director + no client", !!p4.el && doc.body.children.includes(p4.el));
  let threw = false;
  try {
    const s4 = find(p4.el, (e) => e.tagName === "BUTTON" && /save/i.test(e.textContent));
    fire(s4, "click");
    const c4 = find(p4.el, (e) => e.type === "checkbox");
    c4.checked = true; fire(c4, "change");
    const n4 = find(p4.el, (e) => e.tagName === "BUTTON" && /check/i.test(e.textContent));
    fire(n4, "click");
    tickAll();
  } catch (e) { threw = true; console.log("  threw:", e.message); }
  check("null-director interactions never throw", !threw);
  check("status shows n/a without director",
    !!find(p4.el, (e) => String(e.textContent).includes("n/a")));
  p4.destroy();
  check("degraded panel destroy clean", intervals.size === 0 && doc.body.children.length === 0);

  // broken status getter must degrade, not throw (SPEC: bot keeps grinding)
  const p5 = ui.mountAiPanel({ get status() { throw new Error("dead"); } }, { client });
  check("broken director.status degrades to n/a",
    !!find(p5.el, (e) => String(e.textContent).includes("n/a")));
  p5.destroy();

  global.setInterval = realSI; global.clearInterval = realCI;
  delete global.document;

  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
