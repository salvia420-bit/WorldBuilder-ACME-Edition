// test_input_funnel_v2.mjs — the unified gameplay-input funnel (P-unification,
// 2026-07-28). Headless, DOM-free: `ui/input-funnel.js` has no DOM/three.js
// dependency at import time, so the whole dispatch matrix runs under plain node.
//
// THE ACCEPTANCE CRITERION (the user's words):
//   "I'd like streamlining here — this ain't it if some keys will break.
//    If they break they should all break."
//
// So the load-bearing assertions here are the FAULT-INJECTION ones: poison the
// funnel and WASD + Delete + a spellbook key must ALL go dead in the same
// breath; unpoison and they must ALL come back. Before this module those three
// lived on three listeners with three gates and could (and did) fail
// independently — that is the bug this test makes structurally impossible.
//
// Run: node test_input_funnel_v2.mjs

import {
  InputFunnel,
  isTextEntryTarget,
  readInputFunnelV2Flag,
} from "./ui/input-funnel.js";
import { LOCAL_ACTION_IDS } from "./ui/keymap.js";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// localStorage stub — keymap.js's resolveLocalBinding reads it for user
// rebinds. Absent = defaults, which is what most cases want.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis.window || {};

/** Minimal KeyboardEvent stand-in. */
function key(code, opts = {}) {
  return {
    code,
    key: opts.key ?? code,
    shiftKey: !!opts.shift,
    ctrlKey: !!opts.ctrl,
    altKey: !!opts.alt,
    metaKey: !!opts.meta,
    repeat: !!opts.repeat,
    target: opts.target ?? null,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Rig: the three consumers whose independent failure is the bug.
//   - WASD    → a RAW subscriber (index.html's movement keystate shape)
//   - Delete  → an ACTION (combat-bar MAGIC_PREV_SPELL, magic-stance scoped)
//   - Delete  → an ACTION (spellbook DELETE_SPELL, higher priority)
//   - Digit1  → an ACTION (hotbar quickslot)
// ---------------------------------------------------------------------------
function makeRig({ magicStance = true, rowSelected = false } = {}) {
  const funnel = new InputFunnel();
  const hits = { wasd: 0, magicPrev: 0, forgetSpell: 0, hotbar1: 0 };
  funnel.bindRaw("index.gameplay", (ev) => {
    if ("wasdqe".includes((ev.key || "").toLowerCase())) hits.wasd += 1;
  }, { priority: 100 });
  funnel.bindAction(
    LOCAL_ACTION_IDS.MAGIC_PREV_SPELL, "Delete",
    () => { hits.magicPrev += 1; },
    { when: () => magicStance, source: "combat-bar" },
  );
  funnel.bindAction(
    LOCAL_ACTION_IDS.DELETE_SPELL, "Delete",
    () => { hits.forgetSpell += 1; },
    { when: () => rowSelected, priority: 10, source: "spellbook" },
  );
  funnel.bindAction(
    LOCAL_ACTION_IDS.HOTBAR_1, "Digit1",
    () => { hits.hotbar1 += 1; },
    { source: "hotbar" },
  );
  return {
    funnel,
    hits,
    setStance: (v) => { magicStance = v; },
    setRow: (v) => { rowSelected = v; },
  };
}

console.log("\n=== 1. Flag semantics (default-ON, `=off` escape) ===");
check("no param → ON (default)", readInputFunnelV2Flag("") === true);
check("?inputFunnelV2=off → OFF", readInputFunnelV2Flag("?inputFunnelV2=off") === false);
check("?inputFunnelV2=0 → OFF", readInputFunnelV2Flag("?inputFunnelV2=0") === false);
check("?inputFunnelV2=on → ON", readInputFunnelV2Flag("?inputFunnelV2=on") === true);
check("unrelated params → ON", readInputFunnelV2Flag("?wireframe=1&nosw=1") === true);

console.log("\n=== 2. One funnel dispatches every gameplay key ===");
{
  const r = makeRig({ magicStance: true });
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  r.funnel.handleKeyDown(key("Digit1", { key: "1" }));
  check("WASD reached its raw subscriber", r.hits.wasd === 1);
  check("Delete reached the MagicCombat action", r.hits.magicPrev === 1);
  check("Digit1 reached the hotbar action", r.hits.hotbar1 === 1);
  check("no handler errors", r.funnel.stats.handlerErrors === 0);
}

console.log("\n=== 3. THE ACCEPTANCE CRITERION — shared fate (throw) ===");
{
  const r = makeRig({ magicStance: true, rowSelected: true });
  // Baseline: all three alive.
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  r.funnel.handleKeyDown(key("Digit1", { key: "1" }));
  const alive = { ...r.hits };
  check("baseline: WASD alive", alive.wasd === 1);
  check("baseline: Delete alive (spellbook wins on priority)", alive.forgetSpell === 1);
  check("baseline: hotbar alive", alive.hotbar1 === 1);
  check("baseline: combat-bar Delete did NOT double-fire", alive.magicPrev === 0);

  // POISON — a planted throw at the funnel's dispatch head.
  r.funnel.poison("throw");
  let threwW = false, threwDel = false, threwDigit = false;
  try { r.funnel.handleKeyDown(key("KeyW", { key: "w" })); } catch (_) { threwW = true; }
  try { r.funnel.handleKeyDown(key("Delete")); } catch (_) { threwDel = true; }
  try { r.funnel.handleKeyDown(key("Digit1", { key: "1" })); } catch (_) { threwDigit = true; }
  check("poisoned: WASD died", threwW && r.hits.wasd === alive.wasd);
  check("poisoned: Delete died", threwDel && r.hits.forgetSpell === alive.forgetSpell);
  check("poisoned: hotbar died", threwDigit && r.hits.hotbar1 === alive.hotbar1);
  check("poisoned: ALL THREE died together (shared fate)",
    threwW && threwDel && threwDigit);
  check("fault counter reached", r.funnel.stats.faults === 3);

  // UNPOISON — all three live again, together.
  r.funnel.unpoison();
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  r.funnel.handleKeyDown(key("Digit1", { key: "1" }));
  check("unpoisoned: WASD live again", r.hits.wasd === alive.wasd + 1);
  check("unpoisoned: Delete live again", r.hits.forgetSpell === alive.forgetSpell + 1);
  check("unpoisoned: hotbar live again", r.hits.hotbar1 === alive.hotbar1 + 1);
}

console.log("\n=== 4. Shared fate via the ONE gate (gate forced closed) ===");
{
  const r = makeRig({ magicStance: true, rowSelected: true });
  r.funnel.setGate(() => true);
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  r.funnel.handleKeyDown(key("Digit1", { key: "1" }));
  const alive = { ...r.hits };
  check("gate open: all three alive",
    alive.wasd === 1 && alive.forgetSpell === 1 && alive.hotbar1 === 1);

  r.funnel.poison("gate");
  check("gateOpen() reports closed", r.funnel.gateOpen() === false);
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  r.funnel.handleKeyDown(key("Digit1", { key: "1" }));
  check("gate closed: WASD dead", r.hits.wasd === alive.wasd);
  check("gate closed: Delete dead", r.hits.forgetSpell === alive.forgetSpell);
  check("gate closed: hotbar dead", r.hits.hotbar1 === alive.hotbar1);
  check("gateClosed counter reached", r.funnel.stats.gateClosed === 3);

  r.funnel.unpoison();
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  r.funnel.handleKeyDown(key("Digit1", { key: "1" }));
  check("gate reopened: ALL THREE live together",
    r.hits.wasd === alive.wasd + 1 &&
    r.hits.forgetSpell === alive.forgetSpell + 1 &&
    r.hits.hotbar1 === alive.hotbar1 + 1);
}

console.log("\n=== 5. A real in-world gate closes every gameplay key at once ===");
{
  const r = makeRig({ magicStance: true });
  let enteredWorld = false;
  r.funnel.setGate(() => enteredWorld);
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  check("pre-world: WASD gated", r.hits.wasd === 0);
  check("pre-world: Delete gated (SAME gate)", r.hits.magicPrev === 0);
  enteredWorld = true;
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  check("in-world: WASD live", r.hits.wasd === 1);
  check("in-world: Delete live", r.hits.magicPrev === 1);
}

console.log("\n=== 6. Text-entry deference (chat typing must not act) ===");
{
  const r = makeRig({ magicStance: true });
  const input = { tagName: "INPUT", isConnected: true };
  r.funnel.handleKeyDown(key("KeyW", { key: "w", target: input }));
  r.funnel.handleKeyDown(key("Delete", { target: input }));
  r.funnel.handleKeyDown(key("Digit1", { key: "1", target: { tagName: "TEXTAREA", isConnected: true } }));
  check("typing in INPUT: no movement", r.hits.wasd === 0);
  check("typing in INPUT: no Delete action", r.hits.magicPrev === 0);
  check("typing in TEXTAREA: no hotbar", r.hits.hotbar1 === 0);
  check("deferredTyping counter reached", r.funnel.stats.deferredTyping === 3);
  check("contentEditable defers",
    isTextEntryTarget({ target: { tagName: "DIV", isContentEditable: true } }) === true);
  check("plain DIV does not defer",
    isTextEntryTarget({ target: { tagName: "DIV" } }) === false);
  check("SELECT defers",
    isTextEntryTarget({ target: { tagName: "SELECT" } }) === true);
}

console.log("\n=== 7. Action scope (`when`) narrows WHICH action, not WHETHER the funnel lives ===");
{
  const r = makeRig({ magicStance: false });
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  check("out of magic stance: WASD still works", r.hits.wasd === 1);
  check("out of magic stance: MagicCombat Delete correctly out of scope",
    r.hits.magicPrev === 0);
  check("…and the funnel recorded it as unmatched, not as a dead gate",
    r.funnel.stats.unmatched >= 1 && r.funnel.stats.gateClosed === 0);
  r.setStance(true);
  r.funnel.handleKeyDown(key("Delete"));
  check("back in magic stance: Delete fires", r.hits.magicPrev === 1);
}

console.log("\n=== 8. First match wins (no double-dispatch) ===");
{
  const r = makeRig({ magicStance: true, rowSelected: true });
  r.funnel.handleKeyDown(key("Delete"));
  check("exactly ONE Delete consumer ran",
    r.hits.forgetSpell + r.hits.magicPrev === 1);
  check("the higher-priority (spellbook) one won", r.hits.forgetSpell === 1);
  r.setRow(false);
  r.funnel.handleKeyDown(key("Delete"));
  check("row deselected → combat-bar takes Delete", r.hits.magicPrev === 1);
}

console.log("\n=== 9. User rebinds resolve through the ONE keymap ===");
{
  // Exactly what Options → Controls does when the player rebinds a row.
  const { setBinding, clearBinding } = await import("./ui/keymap.js");
  const f = new InputFunnel();
  let hit = 0;
  f.bindAction(LOCAL_ACTION_IDS.MAGIC_PREV_SPELL, "Delete", () => { hit += 1; },
    { source: "combat-bar" });
  f.handleKeyDown(key("Delete"));
  check("default binding fires before any rebind", hit === 1);
  // Rebind "Magic: Previous Spell" off Delete and onto KeyG.
  setBinding(LOCAL_ACTION_IDS.MAGIC_PREV_SPELL,
    { code: "KeyG", shift: false, ctrl: false, alt: false, meta: false });
  f.handleKeyDown(key("Delete"));
  check("rebound away: the DEFAULT key no longer fires", hit === 1);
  f.handleKeyDown(key("KeyG", { key: "g" }));
  check("rebound to: the USER key fires — the funnel reads the ONE keymap",
    hit === 2);
  clearBinding(LOCAL_ACTION_IDS.MAGIC_PREV_SPELL);
  f.handleKeyDown(key("Delete"));
  check("cleared: falls back to the default again", hit === 3);
  store.clear();
}

console.log("\n=== 10. Keyup is ungated (a release must always clear keystate) ===");
{
  const r = makeRig();
  let released = 0;
  r.funnel.bindRawUp("index.gameplay", () => { released += 1; });
  r.funnel.setGate(() => false); // gate slammed shut mid-press
  r.funnel.handleKeyUp(key("KeyW", { key: "w" }));
  check("keyup delivered even with the gate closed", released === 1);
  r.funnel.poison("throw");
  let threw = false;
  try { r.funnel.handleKeyUp(key("KeyW", { key: "w" })); } catch (_) { threw = true; }
  check("keyup shares the fault fate too", threw && released === 1);
}

console.log("\n=== 11. One bad consumer cannot kill the rest (evtGuard rule) ===");
{
  const r = makeRig({ magicStance: true });
  r.funnel.bindRaw("bad.plugin", () => { throw new Error("boom"); }, { priority: 200 });
  r.funnel.handleKeyDown(key("KeyW", { key: "w" }));
  r.funnel.handleKeyDown(key("Delete"));
  check("a throwing raw subscriber does not stop movement", r.hits.wasd === 1);
  check("…nor the Delete action", r.hits.magicPrev === 1);
  check("the throw was counted, not swallowed silently",
    r.funnel.stats.handlerErrors === 2);
}

console.log("\n=== 12. __diag.input() surface ===");
{
  const r = makeRig({ magicStance: true });
  r.funnel.setGate(() => true);
  r.funnel.handleKeyDown(key("Delete"));
  const s = r.funnel.snapshot();
  check("reports gate state", s.gate.injected === true && s.gate.open === true);
  check("reports registered action count", s.actions === 3);
  check("reports registered raw count", s.raws === 1);
  check("reports last dispatch",
    s.lastDispatch?.labelHash === LOCAL_ACTION_IDS.MAGIC_PREV_SPELL &&
    s.lastDispatch?.source === "combat-bar");
  check("reports per-action counters",
    s.perAction.some((a) => a.labelHash === LOCAL_ACTION_IDS.MAGIC_PREV_SPELL && a.count === 1));
  check("reports per-raw counters", s.perRaw[0].count === 1);
  check("reports the fault seam", s.fault === null);
}

console.log("\n=== 13. Source pins — every migrated site rides the funnel ===");
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const idx = read("./index.html");
  check("index.html imports + installs the funnel",
    /getInputFunnel as __getInputFunnel/.test(idx) &&
    /__inputFunnel\.install\(\)/.test(idx));
  check("index.html injects the ONE gate",
    /__inputFunnel\.setGate\(\(\) => enteredWorld && !isTypingInForm\(\)\)/.test(idx));
  check("index.html movement keystate is a funnel raw subscriber",
    /__inputFunnel\.bindRaw\("index\.gameplay"/.test(idx) &&
    /__inputFunnel\.bindRawUp\("index\.gameplay"/.test(idx));
  check("index.html exposes __diag.input() + the fault seam",
    /window\.__diag\.input = \(\)/.test(idx) &&
    /window\.__diag\.input\.poison/.test(idx) &&
    /window\.__diag\.input\.unpoison/.test(idx));

  const cb = read("./plugins/combat-bar.js");
  check("combat-bar registers the MagicCombat map as actions",
    /funnel\.bindAction\(id, def, run, \{/.test(cb) && /source: "combat-bar"/.test(cb));
  check("combat-bar keeps a legacy listener for ?inputFunnelV2=off",
    /if \(inputFunnelV2On\(\)\) \{/.test(cb) && /window\.addEventListener\("keydown"/.test(cb));

  const sb = read("./plugins/spellbook.js");
  check("spellbook forget-spell is a funnel action",
    /bindAction\(\s*LOCAL_ACTION_IDS\.DELETE_SPELL/.test(sb));

  const hb = read("./plugins/hotbar.js");
  check("hotbar quickslots are funnel actions",
    /funnel\.bindAction\(id, def, \(\) => fireSlot\(idx\)/.test(hb));

  const pk = read("./scene3d/picking.js");
  check("picking abort/cancel ride the funnel",
    /funnel\.bindRaw\("picking\.abortCharge"/.test(pk) &&
    /funnel\.bindRaw\("picking\.cancelUseTarget"/.test(pk));

  const cam = read("./scene3d/camera.js");
  check("camera keystate + mode toggle ride the funnel",
    /bindRaw\("camera\.keystate"/.test(cam) &&
    /bindRaw\("camera\.modeToggle"/.test(cam));

  const api = read("./plugins/api.js");
  check("the P6.1 facade exposes client.input.bindAction",
    /bindAction: \(labelHash, defaultBinding, handler, o\)/.test(api));

  const flags = read("./docs/url-flags.md");
  check("url-flags.md documents ?inputFunnelV2", /`inputFunnelV2`/.test(flags));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
