// tests/hud_key_activation.test.mjs — input-options-1 (2026-10-13).
//
// Mouse-clicked HUD controls fired again on Space (jump) and Enter (chat):
// hotbar slots, the toolbar's selected-object field, the radar lock, the
// clickable status indicators and the emote-palette rows are role=button
// divs with tabIndex 0 and an Enter/Space keydown handler. A click left them
// focused; ui/input-funnel.js (a document CAPTURE listener) ran the jump and
// preventDefaulted Space, but the event still reached the focused widget,
// which acted on it a second time. Retail panels never hold keyboard focus
// (every key → CInputManager → ACCmdInterp::OnAction, acclient.c:435951).
//
// CONTRACT
//   [a] hudKeyActivates: a fresh, unconsumed Enter/Space only.
//   [b] the funnel's Space press edge (and any matched action) leaves the
//       event defaultPrevented, so the widget's handler stands down; an
//       unclaimed Enter still reaches a keyboard-focused widget.
//   [c] releaseMouseFocus: a pointer click (detail > 0), a drag, or a press
//       released elsewhere blurs the control; a keyboard / synthetic click
//       (detail 0) keeps focus; it never steals focus the click moved away.
//       A right / middle press blurs on its release (no click follows a
//       non-primary button — review I-ui-input-R1).
//   [d] by source: the five widgets import ui/hud_focus.js and route their
//       keydown through hudKeyActivates + releaseMouseFocus; index.html eats
//       Space autorepeat; hud_focus.js does not lean on :focus-visible.
//   [e] hudOwnsKey (review I-ui-input-R2): a focused HUD control owns its
//       navigation / edit keys (never printable ones); the open radial menu
//       owns every key — global actions (ui/selection_keys.js) stand down.
//
// Run from apps/holtburger-web/:  node tests/hud_key_activation.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hudKeyActivates, releaseMouseFocus, hudOwnsKey, radialMenuOpen } from "../ui/hud_focus.js";
import { InputFunnel } from "../ui/input-funnel.js";
import { LOCAL_ACTION_IDS } from "../ui/keymap.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// keymap.js reads user rebinds from localStorage; absent = defaults.
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem() {}, removeItem() {},
};

/** Minimal KeyboardEvent stand-in (same shape as test_input_funnel_v2.mjs). */
function key(k, opts = {}) {
  return {
    type: "keydown",
    key: k,
    code: opts.code ?? (k === " " ? "Space" : k),
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    repeat: !!opts.repeat,
    target: opts.target ?? null,
    defaultPrevented: !!opts.defaultPrevented,
    preventDefault() { this.defaultPrevented = true; },
  };
}

// ── [a] ────────────────────────────────────────────────────────────────
test("[a] hudKeyActivates: fresh unconsumed Enter/Space only", () => {
  assert.equal(hudKeyActivates(key("Enter")), true, "Enter");
  assert.equal(hudKeyActivates(key(" ")), true, "Space");
  assert.equal(hudKeyActivates(key(" ", { defaultPrevented: true })), false, "Space already used (the jump)");
  assert.equal(hudKeyActivates(key("Enter", { defaultPrevented: true })), false, "Enter already used");
  assert.equal(hudKeyActivates(key("Enter", { repeat: true })), false, "Enter autorepeat");
  assert.equal(hudKeyActivates(key(" ", { repeat: true })), false, "Space autorepeat");
  assert.equal(hudKeyActivates(key("a")), false, "other key");
  assert.equal(hudKeyActivates(key("Spacebar")), false, "not the KeyboardEvent.key for Space");
  assert.equal(hudKeyActivates(null), false, "null");
  assert.equal(hudKeyActivates(undefined), false, "undefined");
});

// ── [b] ────────────────────────────────────────────────────────────────
/** The capture → target path a keydown takes to a focused HUD widget. */
function rig() {
  const funnel = new InputFunnel().setGate(() => true);
  const hits = { jump: 0, widget: 0, action: 0 };
  // index.html __gameplayKeyDown's Space branch: press edge → jump + preventDefault.
  funnel.bindRaw("index.gameplay", (ev) => {
    if (ev.key === " " && !ev.repeat) { hits.jump += 1; ev.preventDefault(); }
  }, { priority: 100 });
  // The shared widget handler shape (hotbar / target-bar / radar / status / emote).
  const widgetKeydown = (ev) => {
    if (!hudKeyActivates(ev)) return;
    ev.preventDefault();
    hits.widget += 1;
  };
  const press = (ev) => { funnel.handleKeyDown(ev); widgetKeydown(ev); return ev; };
  return { funnel, hits, press };
}

test("[b] Space: the funnel's jump consumes it — the focused widget does not fire", () => {
  const { funnel, hits, press } = rig();
  const ev = key(" ");
  funnel.handleKeyDown(ev);
  assert.equal(ev.defaultPrevented, true, "funnel preventDefaulted the jump key");
  assert.equal(hudKeyActivates(ev), false, "the same event no longer activates a widget");
  press(key(" "));
  press(key(" ", { repeat: true }));
  press(key(" ", { repeat: true }));
  assert.equal(hits.jump, 2, "one jump per press edge");
  assert.equal(hits.widget, 0, "no slot use / examine / lock toggle / emote");
});

test("[b] Enter: unclaimed by the funnel, it still activates a keyboard-focused widget once", () => {
  const { hits, press } = rig();
  const ev = press(key("Enter"));
  assert.equal(hits.widget, 1, "Tab-focused control keeps Enter");
  assert.equal(ev.defaultPrevented, true, "the widget claimed it (chat stays shut for a keyboard user)");
  press(key("Enter", { repeat: true }));
  assert.equal(hits.widget, 1, "autorepeat does not re-fire");
});

test("[b] a matched funnel ACTION also consumes its key before the widget", () => {
  const { funnel, hits, press } = rig();
  funnel.bindAction(LOCAL_ACTION_IDS.NEXT_MONSTER, "Enter", () => { hits.action += 1; }, { source: "test" });
  const ev = press(key("Enter", { code: "Enter" }));
  assert.equal(hits.action, 1, "action ran");
  assert.equal(ev.defaultPrevented, true);
  assert.equal(hits.widget, 0, "widget stood down");
});

// ── [c] ────────────────────────────────────────────────────────────────
function makeDoc() {
  const doc = {
    body: { tagName: "BODY" },
    activeElement: null,
    listeners: [],
    addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn, capture) {
      this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === !!capture));
    },
    fire(type, ev) { for (const l of [...this.listeners]) if (l.type === type) l.fn({ type, ...ev }); },
  };
  doc.activeElement = doc.body;
  return doc;
}
function makeEl(doc, name = "slot") {
  const el = {
    name,
    ownerDocument: doc,
    listeners: [],
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)); },
    fire(type, ev = {}) { for (const l of [...this.listeners]) if (l.type === type) l.fn({ type, target: el, ...ev }); },
    contains(t) { return t === el; },
    focus() { doc.activeElement = el; },
    blur() { if (doc.activeElement === el) doc.activeElement = doc.body; },
  };
  return el;
}
/** A real mouse click: mousedown focuses, pointerup + click land on the control. */
function mouseClick(doc, el, upTarget = el) {
  el.fire("pointerdown");
  el.focus();
  doc.fire("pointerup", { target: upTarget });
  if (upTarget === el) el.fire("click", { detail: 1 });
}

test("[c] a mouse click blurs the control after its own click handler ran", () => {
  const doc = makeDoc();
  const el = makeEl(doc);
  let focusedDuringClick = null;
  el.addEventListener("click", () => { focusedDuringClick = doc.activeElement === el; });
  releaseMouseFocus(el);
  mouseClick(doc, el);
  assert.equal(focusedDuringClick, true, "the control's own click ran first");
  assert.equal(doc.activeElement, doc.body, "focus released");
  assert.equal(doc.listeners.length, 0, "the pointerup arm is gone");
});

test("[c] keyboard / synthetic activation (click detail 0) keeps focus", () => {
  const doc = makeDoc();
  const el = makeEl(doc);
  releaseMouseFocus(el);
  el.focus();
  el.fire("click", { detail: 0 }); // radar lockBtn.click() from its keydown
  assert.equal(doc.activeElement, el, "a Tab-focused control keeps the keyboard");
});

test("[c] a press released somewhere else (no click) still releases focus", () => {
  const doc = makeDoc();
  const el = makeEl(doc);
  releaseMouseFocus(el);
  const elsewhere = { tagName: "CANVAS" };
  mouseClick(doc, el, elsewhere);
  assert.equal(doc.activeElement, doc.body, "blurred on the outside release");
  assert.equal(doc.listeners.length, 0, "disarmed");
});

test("[c] a right / middle press released OVER the control blurs (no click follows a non-primary button)", () => {
  // Review I-ui-input-R1: Chromium/Firefox focus a tabIndex div on any
  // mousedown button, but fire `click` only for button 0 (auxclick otherwise).
  for (const button of [1, 2]) {
    const doc = makeDoc();
    const el = makeEl(doc);
    let clicks = 0;
    el.addEventListener("click", () => { clicks += 1; });
    releaseMouseFocus(el);
    el.fire("pointerdown", { button });
    el.focus();
    doc.fire("pointerup", { target: el, button });
    assert.equal(clicks, 0, `button ${button}: no click in this sequence`);
    assert.equal(doc.activeElement, doc.body, `button ${button}: focus released on the release itself`);
    assert.equal(doc.listeners.length, 0, `button ${button}: disarmed`);
  }
});

test("[c] a primary release over the control still waits for its click (action runs focused)", () => {
  const doc = makeDoc();
  const el = makeEl(doc);
  releaseMouseFocus(el);
  el.fire("pointerdown", { button: 0 });
  el.focus();
  doc.fire("pointerup", { target: el, button: 0 });
  assert.equal(doc.activeElement, el, "not blurred before the click handler");
  el.fire("click", { detail: 1 });
  assert.equal(doc.activeElement, doc.body, "the click blurs it");
});

test("[c] drag source: dragend / pointercancel release focus and disarm", () => {
  const doc = makeDoc();
  const el = makeEl(doc);
  releaseMouseFocus(el);
  el.fire("pointerdown");
  el.focus();
  el.fire("pointercancel"); // Chromium cancels the pointer when a native drag starts
  assert.equal(doc.activeElement, doc.body, "pointercancel");
  assert.equal(doc.listeners.length, 0, "disarmed on cancel");
  el.focus();
  el.fire("dragend");
  assert.equal(doc.activeElement, doc.body, "dragend");
});

test("[c] never steals focus the click moved elsewhere (a panel input it opened)", () => {
  const doc = makeDoc();
  const el = makeEl(doc);
  const input = { tagName: "INPUT" };
  el.addEventListener("click", () => { doc.activeElement = input; });
  releaseMouseFocus(el);
  mouseClick(doc, el);
  assert.equal(doc.activeElement, input, "focus left where the click put it");
});

test("[c] repeated presses arm once; dispose removes every listener", () => {
  const doc = makeDoc();
  const el = makeEl(doc);
  const dispose = releaseMouseFocus(el);
  el.fire("pointerdown");
  el.fire("pointerdown");
  assert.equal(doc.listeners.length, 1, "armed once");
  dispose();
  assert.equal(doc.listeners.length, 0, "disarmed by dispose");
  assert.equal(el.listeners.length, 0, "element listeners removed");
  el.focus();
  el.fire("click", { detail: 1 });
  assert.equal(doc.activeElement, el, "inert after dispose");
});

test("[c] tolerates a missing element", () => {
  assert.equal(typeof releaseMouseFocus(null), "function");
  assert.doesNotThrow(() => releaseMouseFocus(null)());
});

// ── [d] ────────────────────────────────────────────────────────────────
const WIDGETS = [
  "plugins/hotbar.js",
  "plugins/target-bar.js",
  "plugins/radar.js",
  "plugins/status-indicators.js",
  "plugins/emote-panel.js",
];

test("[d] every HUD widget routes its keydown through ui/hud_focus.js", () => {
  for (const rel of WIDGETS) {
    const s = src(rel);
    assert.match(s, /import \{ hudKeyActivates, releaseMouseFocus \} from "\.\.\/ui\/hud_focus\.js";/, `${rel} imports hud_focus.js`);
    assert.match(s, /if \(!hudKeyActivates\(ev\)\) return;/, `${rel} keydown gated by hudKeyActivates`);
    assert.match(s, /releaseMouseFocus\(/, `${rel} releases mouse focus`);
    assert.doesNotMatch(s, /ev\.key === "Enter" \|\| ev\.key === " "/, `${rel} has no ungated Enter/Space handler left`);
  }
});

test("[d] the keydown handlers sit next to the tabIndex=0 controls they guard", () => {
  const near = (rel, anchor, n = 1200) => {
    const s = src(rel);
    const i = s.indexOf(anchor);
    assert.ok(i >= 0, `${rel}: anchor ${anchor}`);
    return s.slice(i, i + n);
  };
  assert.match(near("plugins/hotbar.js", "el.tabIndex = 0;", 3000), /hudKeyActivates\(ev\)[\s\S]*fireSlot\(i\);[\s\S]*releaseMouseFocus\(el\);/);
  assert.match(near("plugins/target-bar.js", "target.tabIndex = 0;", 3000), /hudKeyActivates\(ev\)[\s\S]*examineSelected\(\);[\s\S]*releaseMouseFocus\(target\);/);
  assert.match(near("plugins/radar.js", "const onLockKey", 400), /hudKeyActivates\(ev\)[\s\S]*lockBtn\.click\(\);[\s\S]*releaseMouseFocus\(lockBtn\)/);
  assert.match(src("plugins/radar.js"), /releaseLockFocus\(\);/, "radar teardown disposes it");
  assert.match(near("plugins/status-indicators.js", "el.tabIndex = 0;", 1600), /hudKeyActivates\(ev\)[\s\S]*activate\(\);[\s\S]*releaseMouseFocus\(el\);/);
  assert.match(near("plugins/emote-panel.js", "row.tabIndex = 0;", 1600), /hudKeyActivates\(ev\)[\s\S]*run\(entry\);[\s\S]*releaseMouseFocus\(row\);/);
});

test("[d] index.html consumes Space autorepeat before the jump press edge", () => {
  const s = src("index.html");
  const i = s.indexOf('if (ev.key === " " && ev.repeat) ev.preventDefault();');
  const j = s.indexOf('if (ev.key === " " && handle && !ev.repeat) {');
  assert.ok(i > 0, "Space-repeat preventDefault present");
  assert.ok(j > i && j - i < 200, "immediately ahead of the jump press edge");
});

test("[d] hud_focus.js does not use :focus-visible as its keyboard test", () => {
  const code = src("ui/hud_focus.js").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /focus-visible/);
  assert.doesNotMatch(code, /\bimport\b/, "dependency-free");
});

// ── [e] hudOwnsKey (review I-ui-input-R2) ─────────────────────────────────
function ctl(attrs, connected = true) {
  return {
    isConnected: connected,
    getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
  };
}

test("[e] hudOwnsKey: a focused control owns its navigation / edit keys, never printable ones", () => {
  const doc = { body: ctl({}), documentElement: ctl({}), activeElement: null };
  doc.activeElement = doc.body;
  const win = {};
  const owns = (k, target = null) => hudOwnsKey(key(k, { target }), { doc, win });
  const slot = ctl({ tabindex: "0", role: "button" });
  for (const k of ["Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowUp", "Enter", " ", "Escape"]) {
    assert.equal(owns(k, slot), true, `${JSON.stringify(k)} belongs to the focused slot`);
  }
  for (const k of ["p", "n", ",", ".", "-", "=", "\\", "/", "[", "Tab"]) {
    assert.equal(owns(k, slot), false, `${JSON.stringify(k)} is not a control key`);
  }
  assert.equal(owns("Home", ctl({ role: "tab" })), true, "explicit widget role (Options tab button)");
  assert.equal(owns("Home", ctl({ role: "TabList " })), true, "role match is trimmed / case-folded");
  assert.equal(owns("Home", ctl({ tabindex: "-1" })), true, "a list overlay / window root that took focus");
  assert.equal(owns("Home", ctl({})), false, "a native <button> left focused by a click is not an owner");
  assert.equal(owns("Home", ctl({ role: "presentation" })), false, "non-widget role");
  assert.equal(owns("Backspace", ctl({ tabindex: "0" }, false)), false, "detached control owns nothing");
  assert.equal(owns("Home", doc.body), false, "body focus = gameplay");
  // Falls back to document.activeElement when the event target is not a control.
  doc.activeElement = slot;
  assert.equal(owns("Backspace"), true, "activeElement fallback");
  doc.activeElement = doc.body;
  assert.equal(hudOwnsKey(null, { doc, win }), false);
  assert.equal(hudOwnsKey(undefined, { doc, win }), false);
});

test("[e] hudOwnsKey: the open radial menu owns every key; radialMenuOpen reads its flag", () => {
  const doc = { body: ctl({}), documentElement: ctl({}), activeElement: null };
  doc.activeElement = doc.body;
  const win = { __radialMenuOpen: true };
  for (const k of ["p", "n", ",", "Home", "Backspace"]) {
    assert.equal(hudOwnsKey(key(k), { doc, win }), true, `${k} → radial`);
  }
  assert.equal(hudOwnsKey(undefined, { doc, win }), true, "no event needed while the menu is open");
  assert.equal(radialMenuOpen(win), true);
  win.__radialMenuOpen = false;
  assert.equal(radialMenuOpen(win), false);
  assert.equal(hudOwnsKey(key("p"), { doc, win }), false);
  assert.equal(radialMenuOpen(null), false);
});

test("[e] plugins/radial-menu.js still publishes window.__radialMenuOpen on open and close", () => {
  const s = src("plugins/radial-menu.js");
  assert.match(s, /window\.__radialMenuOpen = true;/);
  assert.match(s, /window\.__radialMenuOpen = false;/);
});
