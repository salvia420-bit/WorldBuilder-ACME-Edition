// tests/rynth_vt_meta_views.test.mjs — rynth/vt/meta views.js + meta_fns.js
// (W1-4 META, PLAN §2.9 X6, §3.12; U5 §7).
//
// ViewManager with a fake parseXml (stands in for formats/view_xml.js) and a
// fake renderer (stands in for plugins/rynth-vt/meta_views.js): create /
// replace / destroy / destroyAll, late renderer attach, click = actionexpr
// THEN setstate, the ui* expression functions on a fake FunctionRegistry,
// the meta-state functions, and the CreateView/DestroyAllViews actions
// through a real MetaEngine. No other vt package is imported (C2).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_meta_views.test.mjs

import assert from "node:assert/strict";

const M = await import("../rynth/vt/meta/index.js");
const { ViewManager, registerViewFunctions, registerMetaFunctions, VIEW_FUNCTION_NAMES, META_FUNCTION_NAMES, MetaEngine } = M;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

// The ColRings "Turn In" view (CORPUS ColRings-c3986fd7f878c745.met, U5 §7) as
// formats/view_xml.js would return it.
const COLRINGS = {
  title: "Turn In",
  width: 80,
  height: 120,
  controls: [
    { type: "button", name: "Go", left: 5, top: 5, width: 70, height: 30, text: "Go", setstate: "TurnIn", actionexpr: "" },
    { type: "button", name: "Cancel", left: 5, top: 40, width: 70, height: 30, text: "Cancel", setstate: "Default", actionexpr: "chatbox[\\/ub mexec clearallvars\\[\\]]" },
    { type: "button", name: "Select", left: 5, top: 75, width: 70, height: 30, text: "Exit", setstate: "Exit", actionexpr: "" },
  ],
};
const MIXED = {
  title: "Mixed",
  width: 100,
  height: 100,
  controls: [
    { type: "label", name: "Lbl", text: "Hello", actionexpr: "x", setstate: "nope" },
    { type: "checkbox", name: "Chk", text: "Loot", checked: false, actionexpr: "toggled", setstate: "" },
    { type: "unsupported", name: "Sl", text: "", origType: "slider", setstate: "nope" },
    { type: "button", name: "Boom", text: "Boom", actionexpr: "bad", setstate: "After" },
    { type: "button", name: "Kill", text: "Kill", actionexpr: "destroy", setstate: "Killed" },
  ],
};
const XMLS = { colrings: COLRINGS, mixed: MIXED };

function makeParse() {
  const seen = [];
  const parseXml = (xml) => {
    seen.push(xml);
    if (xml === "BAD") return { ok: false, warnings: ["dropped <script>"], error: "unbalanced <control>" };
    const m = XMLS[xml];
    return m ? { ok: true, model: JSON.parse(JSON.stringify(m)), warnings: xml === "mixed" ? ["control type slider unsupported"] : [] } : { ok: false, warnings: [], error: "unknown fixture" };
  };
  return { parseXml, seen };
}

function makeRenderer() {
  let n = 0;
  const calls = [];
  return {
    calls,
    render(name, model) {
      const h = { id: ++n, name };
      calls.push(["render", name, h.id, model.controls.length]);
      return h;
    },
    update(h, model) {
      calls.push(["update", h.id, model.controls.map((c) => `${c.name}:${c.text}:${c.visible ? 1 : 0}${c.type === "checkbox" ? `:${c.checked ? 1 : 0}` : ""}`).join(",")]);
    },
    destroy(h) {
      calls.push(["destroy", h.id]);
    },
  };
}

function makeVm({ renderer = makeRenderer(), evaluate = null } = {}) {
  const order = [];
  const logs = [];
  const { parseXml, seen } = makeParse();
  let vm;
  vm = new ViewManager({
    parseXml,
    renderer,
    evaluate:
      evaluate ||
      ((src) => {
        order.push(["expr", src]);
        if (src === "bad") return { t: "err", msg: "Call to unknown function \"bad\"" };
        if (src === "destroy") vm.destroyAll();
        return 1;
      }),
    setState: (s) => order.push(["state", s]),
    log: (m) => logs.push(m),
    now: () => 0,
  });
  return { vm, renderer, order, logs, seen };
}

function fakeRegistry() {
  const fns = new Map();
  return {
    define(name, impl, opts = {}) {
      fns.set(String(name).toLowerCase(), { impl, ...opts });
      return true;
    },
    get: (n) => fns.get(String(n).toLowerCase()) || null,
    call(n, ...args) {
      const f = fns.get(String(n).toLowerCase());
      assert.ok(f, `function ${n} registered`);
      if (Number.isFinite(f.minArgs)) assert.ok(args.length >= f.minArgs, `${n} minArgs`);
      if (Number.isFinite(f.maxArgs)) assert.ok(args.length <= f.maxArgs, `${n} maxArgs`);
      return f.impl(args, {});
    },
    names: () => [...fns.keys()].sort(),
  };
}

// ── ViewManager ──────────────────────────────────────────────────────────

await check("create renders the parsed model (ColRings: 3 buttons, every control visible)", () => {
  const { vm, renderer } = makeVm();
  const r = vm.create("Turn In", "colrings");
  assert.equal(r.ok, true);
  assert.deepEqual(renderer.calls, [["render", "Turn In", 1, 3]]);
  assert.equal(vm.exists("turn in"), true, "names are case-insensitive");
  assert.equal(vm.visible("Turn In"), true);
  const m = vm.model("Turn In");
  assert.deepEqual(m.controls.map((c) => [c.type, c.name, c.visible]), [["button", "Go", true], ["button", "Cancel", true], ["button", "Select", true]]);
  assert.deepEqual(vm.list(), ["Turn In"]);
});

await check("create with the same name REPLACES the view (old handle destroyed, new one rendered)", () => {
  const { vm, renderer } = makeVm();
  vm.create("V", "colrings");
  vm.create("v", "mixed");
  assert.deepEqual(renderer.calls, [["render", "V", 1, 3], ["destroy", 1], ["render", "v", 2, 5]]);
  assert.deepEqual(vm.list(), ["v"]);
  assert.equal(vm.model("V").title, "Mixed");
});

await check("destroy / destroyAll remove views and their rendered windows", () => {
  const { vm, renderer } = makeVm();
  vm.create("A", "colrings");
  vm.create("B", "colrings");
  vm.create("C", "colrings");
  assert.deepEqual(vm.destroy("b"), { ok: true });
  assert.deepEqual(vm.destroy("nope"), { ok: false });
  assert.equal(vm.exists("B"), false);
  vm.destroyAll();
  assert.deepEqual(vm.list(), []);
  assert.deepEqual(renderer.calls.filter((c) => c[0] === "destroy").map((c) => c[1]), [2, 1, 3]);
});

await check("parse failure / no parser / no name ⇒ { ok:false, error } and nothing rendered; parser warnings logged", () => {
  const { vm, renderer, logs } = makeVm();
  const r = vm.create("X", "BAD");
  assert.equal(r.ok, false);
  assert.match(r.error, /unbalanced/);
  assert.deepEqual(r.warnings, ["dropped <script>"]);
  assert.ok(logs.some((l) => /dropped <script>/.test(l)));
  assert.equal(vm.create("", "colrings").ok, false);
  assert.equal(new ViewManager({ log: () => {} }).create("X", "colrings").ok, false);
  assert.deepEqual(renderer.calls, []);
  assert.equal(vm.exists("X"), false);
});

await check("no renderer ⇒ the view exists but is not visible; setRenderer() later renders every view; null detaches", () => {
  const { parseXml } = makeParse();
  const vm = new ViewManager({ parseXml, log: () => {} });
  vm.create("A", "colrings");
  vm.create("B", "mixed");
  assert.equal(vm.exists("A"), true);
  assert.equal(vm.visible("A"), false);
  const r = makeRenderer();
  vm.setRenderer(r);
  assert.deepEqual(r.calls, [["render", "A", 1, 3], ["render", "B", 2, 5]]);
  assert.equal(vm.visible("B"), true);
  vm.setRenderer(null);
  assert.deepEqual(r.calls.slice(2), [["destroy", 1], ["destroy", 2]]);
  assert.equal(vm.visible("A"), false);
  assert.equal(vm.exists("A"), true);
});

await check("a throwing renderer never breaks the manager", () => {
  const bad = { render() { throw new Error("dom gone"); }, update() { throw new Error("x"); }, destroy() { throw new Error("y"); } };
  const { parseXml } = makeParse();
  const logs = [];
  const vm = new ViewManager({ parseXml, renderer: bad, log: (m) => logs.push(m) });
  assert.equal(vm.create("A", "colrings").ok, true);
  assert.equal(vm.visible("A"), false);
  vm.destroyAll();
  assert.ok(logs.some((l) => /render failed/.test(l)));
});

await check("click: actionexpr is evaluated THEN setstate is entered (U5 §7); empty actionexpr ⇒ setstate only", () => {
  const { vm, order } = makeVm();
  vm.create("Turn In", "colrings");
  assert.deepEqual(vm.click("Turn In", "Cancel"), { ok: true });
  assert.deepEqual(order, [["expr", "chatbox[\\/ub mexec clearallvars\\[\\]]"], ["state", "Default"]]);
  order.length = 0;
  vm.click("turn in", "go");
  assert.deepEqual(order, [["state", "TurnIn"]]);
});

await check("click: an actionexpr error is reported but setstate still runs; a view destroyed by its own actionexpr still sets state", () => {
  const { vm, order } = makeVm();
  vm.create("M", "mixed");
  const r = vm.click("M", "Boom");
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown function/);
  assert.deepEqual(order, [["expr", "bad"], ["state", "After"]]);
  order.length = 0;
  vm.click("M", "Kill");
  assert.deepEqual(order, [["expr", "destroy"], ["state", "Killed"]]);
  assert.equal(vm.exists("M"), false);
});

await check("click: labels / unsupported placeholders do nothing; a checkbox toggles `checked` then runs its actionexpr", () => {
  const { vm, order, renderer } = makeVm();
  vm.create("M", "mixed");
  assert.equal(vm.click("M", "Lbl").ok, false);
  assert.equal(vm.click("M", "Sl").ok, false);
  assert.deepEqual(order, []);
  vm.click("M", "Chk");
  assert.deepEqual(order, [["expr", "toggled"]]);
  assert.equal(vm.model("M").controls.find((c) => c.name === "Chk").checked, true);
  assert.ok(renderer.calls.some((c) => c[0] === "update" && /Chk:Loot:1:1/.test(c[2])));
  vm.click("M", "Chk");
  assert.equal(vm.model("M").controls.find((c) => c.name === "Chk").checked, false);
  assert.equal(vm.click("nope", "Go").ok, false);
  assert.equal(vm.click("M", "nope").ok, false);
});

await check("ui* functions: uiviewexists / uiviewvisible / uigetcontrol handle or Err / uisetlabel / uisetvisible", () => {
  const { vm, renderer, order } = makeVm();
  const reg = fakeRegistry();
  registerViewFunctions(reg, vm);
  assert.deepEqual(reg.names(), [...VIEW_FUNCTION_NAMES].sort());
  assert.equal(reg.call("uiviewexists", "Turn In"), false);
  vm.create("Turn In", "colrings");
  assert.equal(reg.call("uiviewexists", "turn in"), true);
  assert.equal(reg.call("uiviewvisible", "Turn In"), true);
  const h = reg.call("uigetcontrol", "Turn In", "go");
  assert.equal(h, "Turn In/Go");
  const missing = reg.call("uigetcontrol", "Turn In", "Nope");
  assert.equal(missing.t, "err");
  assert.equal(reg.call("uigetcontrol", "Nope", "Go").t, "err");
  assert.equal(reg.call("uisetlabel", h, "Go now"), true);
  assert.equal(vm.model("Turn In").controls[0].text, "Go now");
  assert.ok(renderer.calls.at(-1)[0] === "update" && /Go:Go now:1/.test(renderer.calls.at(-1)[2]));
  assert.equal(reg.call("uisetvisible", h, 0), true);
  assert.equal(vm.model("Turn In").controls[0].visible, false);
  assert.equal(vm.click("Turn In", "Go").ok, false, "a hidden control is not clickable");
  assert.deepEqual(order, []);
  assert.equal(reg.call("uisetvisible", h, "1"), true);
  assert.equal(vm.model("Turn In").controls[0].visible, true);
  assert.equal(reg.call("uisetlabel", "Nope/Go", "x"), false);
});

await check("handles resolve with '/' inside view names (longest view-name prefix wins)", () => {
  const { vm } = makeVm();
  const reg = fakeRegistry();
  registerViewFunctions(reg, () => vm);
  vm.create("A", "colrings");
  vm.create("A/B", "colrings");
  const h = reg.call("uigetcontrol", "A/B", "Go");
  assert.equal(h, "A/B/Go");
  reg.call("uisetlabel", h, "deep");
  assert.equal(vm.model("A/B").controls[0].text, "deep");
  assert.equal(vm.model("A").controls[0].text, "Go");
});

await check("ui* functions without a view manager: exists/visible false, uigetcontrol Err; custom truthy honoured", () => {
  const reg = fakeRegistry();
  registerViewFunctions(reg, () => null);
  assert.equal(reg.call("uiviewexists", "x"), false);
  assert.equal(reg.call("uigetcontrol", "x", "y").t, "err");
  assert.equal(reg.call("uisetvisible", "x/y", 1), false);
  const { vm } = makeVm();
  vm.create("V", "colrings");
  const reg2 = fakeRegistry();
  registerViewFunctions(reg2, vm, { truthy: (v) => v === "show" });
  reg2.call("uisetvisible", "V/Go", "1");
  assert.equal(vm.model("V").controls[0].visible, false, "the injected truthy decides");
  reg2.call("uisetvisible", "V/Go", "show");
  assert.equal(vm.model("V").controls[0].visible, true);
  registerViewFunctions(null, vm); // no registry: no throw
});

// ── meta-state functions ────────────────────────────────────────────────

await check("vtgetmetastate/ragetmetastate/getmetastate and the setters (enterState(s, \"expr\") → 1; empty → 0)", () => {
  const entered = [];
  const engine = { state: "Hunting", enterState: (s, why) => (entered.push([s, why]), true) };
  const reg = fakeRegistry();
  registerMetaFunctions(reg, () => engine);
  assert.deepEqual(reg.names(), [...META_FUNCTION_NAMES].sort());
  for (const n of ["vtgetmetastate", "ragetmetastate", "getmetastate"]) assert.equal(reg.call(n), "Hunting");
  assert.equal(reg.call("vtsetmetastate", "dead"), 1);
  assert.equal(reg.call("rasetmetastate", "Hunting"), 1, "same state re-arms (engine decides)");
  assert.equal(reg.call("setmetastate", 7), 1);
  assert.equal(reg.call("setmetastate", "  "), 0);
  assert.deepEqual(entered, [["dead", "expr"], ["Hunting", "expr"], ["7", "expr"]]);
  const none = fakeRegistry();
  registerMetaFunctions(none, () => null);
  assert.equal(none.call("getmetastate"), "");
  assert.equal(none.call("setmetastate", "x").t, "err");
});

// ── through the engine ──────────────────────────────────────────────────

await check("engine: CreateView / DestroyView / DestroyAllViews actions drive the ViewManager; a meta load destroys views; a click enters the state", () => {
  const clock = { t: 1_800_000_000_000 };
  const { parseXml } = makeParse();
  const renderer = makeRenderer();
  let engine;
  const evaluated = [];
  const vm = new ViewManager({ parseXml, renderer, evaluate: (s) => (evaluated.push(s), 1), setState: (s) => engine.enterState(s, "manual"), log: () => {}, now: () => clock.t });
  const out = [];
  const ctx = {
    print: (t) => out.push(t),
    settings: { getValue: (k) => k === "EnableMeta", get: () => ({ ok: false }), set: () => ({ ok: true }) },
    chat: { run: (l) => out.push(l) },
    views: vm,
  };
  const expr = { evaluate: (s) => s, vars: { flush() {} }, pump() {}, setVar() {} };
  engine = new MetaEngine({ ctx, expr, getRegex: (p, f) => new RegExp(p, f), values: { truthy: (v) => !!v, toStr: String, isErr: (v) => !!v && v.t === "err" }, setVar() {}, state: {}, now: () => clock.t, log: () => {} });
  const meta = {
    rules: [
      { id: "r1", state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "CreateView", view: "Turn In", xml: "colrings" } },
      { id: "r2", state: "Default", enabled: true, cond: { t: "Always" }, act: { t: "CreateView", view: "Bad", xml: "BAD" } },
      { id: "r3", state: "TurnIn", enabled: true, cond: { t: "Always" }, act: { t: "Chat", text: "/x turning in" } },
      { id: "r4", state: "Exit", enabled: true, cond: { t: "Always" }, act: { t: "DestroyAllViews" } },
    ],
    navs: {},
  };
  engine.load(meta);
  const tick = () => {
    clock.t += 100;
    engine.tick(clock.t, { running: true });
  };
  tick();
  assert.equal(vm.exists("Turn In"), true);
  assert.equal(vm.exists("Bad"), false);
  assert.ok(out.some((l) => /CreateView Bad: unbalanced/.test(l)), "failed CreateView reported once");
  vm.click("Turn In", "Go");
  assert.equal(engine.state, "TurnIn");
  tick();
  assert.ok(out.includes("/x turning in"));
  vm.click("Turn In", "Select");
  tick();
  assert.equal(engine.state, "Exit");
  assert.equal(vm.exists("Turn In"), false, "DestroyAllViews");
  vm.create("Again", "colrings");
  engine.load(meta);
  assert.equal(vm.exists("Again"), false, "views die on meta load");
});

console.log(fail === 0 ? `rynth_vt_meta_views: all ${pass} checks passed` : `rynth_vt_meta_views: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
