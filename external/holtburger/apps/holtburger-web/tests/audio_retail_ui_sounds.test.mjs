// audio_retail_ui_sounds.test.mjs — audio-2: the client plays only the UI
// sounds retail plays, and the button chime lands on PRESS.
//
// Retail's own UI sounds are the PlaySoundFromCenter callers in acclient.c:
// MediaMachine::Update_Sound (162259 / 162267, LayoutDesc Sound media — the
// UI_ButtonPress a UIElement_Button plays when MouseDown, 174702, enters its
// Pressed state), Sound_UI_EnterPortal / ExitPortal (261845 / 262562) and
// Handle_Admin__Environs (396439-396539). Sound_UI_GeneralError (0x6D),
// GrabSlider (0x73) and ReleaseSlider (0x74) are acclient.h enum values with
// no reference in acclient.c.
//
// Fails on the old code:
//   - plugins/audio_optimistic.js played 0x6D from playUiError() on every
//     drag / vendor refusal and 0x73 / 0x74 on every <input type=range>
//     press / release (the default arms below see playFromCenter calls);
//   - plugins/ui_click_sounds.js chimed on `click` (after the release) and
//     had no `pointerdown` listener, so the default press arm hears nothing
//     and the click-alone arm hears the chime.
//   - review A-audio-R1: the first press-chime version also chimed on the
//     pointerdown that starts an HTML5 drag (draggable inventory / hotbar /
//     spell slots), which `click` never did; the drag-source arms catch it.
// `?retailUiSounds=off` (or 0/false) restores both old behaviours.
//
// Run: node tests/audio_retail_ui_sounds.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  ok  ${name}`); };

// ── fake window / document ──────────────────────────────────────────────
const winListeners = new Map();   // type -> [fn]   (audio_optimistic, capture)
const docListeners = [];          // { type, fn, capture }  (ui_click_sounds)
const calls = [];                 // audioManager voices: { fn, wave, vol }
const order = [];                 // gesture / play ordering for the first press
const resolved = [];
let gestureNotified = false;
let clock = 10_000;

const audioManager = {
  notifyUserGesture() { order.push("gesture"); gestureNotified = true; },
  // Like AudioManager._ensureRunning: no AudioContext before the gesture,
  // so a play that lands first is dropped.
  playFromCenter: async (wave, vol) => {
    if (!gestureNotified) { order.push("dropped"); return null; }
    order.push("play");
    calls.push({ fn: "center", wave: wave >>> 0, vol });
    return {};
  },
  play: async (wave) => { calls.push({ fn: "play", wave: wave >>> 0 }); return {}; },
};

const LPG = 0x5000_0001;
globalThis.window = {
  addEventListener: (type, fn) => {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  },
  getLocalPlayerGuid: () => LPG,
  liveScene3d: {
    audioManager,
    soundTableCache: {
      resolveSound: async (stb, st) => {
        resolved.push([stb >>> 0, st >>> 0]);
        return { waveDid: 0x0a00_0000 | (st >>> 0), volume: 0.8, probability: 1 };
      },
    },
    wasmExports: { resolveClientEnumDid: async (e, c) => (e === 0x10000003 && c === 7 ? 0x2000004b : 0) },
    entityManager: { entityMap: new Map([[LPG, { soundTableDid: 0x20000001, root: { position: { x: 1, y: 2, z: 3 } } }]]) },
  },
};
globalThis.document = {
  addEventListener: (type, fn, capture) => { docListeners.push({ type, fn, capture: !!capture }); },
  removeEventListener: (type, fn, capture) => {
    const i = docListeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
    if (i >= 0) docListeners.splice(i, 1);
  },
};
performance.now = () => clock;

const tick = () => new Promise((r) => setTimeout(r, 0));
const setSearch = (search) => {
  if (search === null) delete window.location;
  else window.location = { search };
};
const fireWin = async (type, target) => {
  for (const fn of winListeners.get(type) || []) fn({ target, button: 0 });
  await tick();
};
// Document listeners, then a microtask/macrotask flush — the browser runs a
// microtask checkpoint after every listener callback, so the async chime
// chain can reach playFromCenter before the next listener runs.
const fireDoc = async (type, ev) => {
  clock += 1000;   // past ui_click_sounds' 60 ms dedupe
  for (const l of docListeners.filter((x) => x.type === type)) l.fn(ev);
  await tick();
};
const centrePlays = (wave) => calls.filter((c) => c.fn === "center" && (wave === undefined || c.wave === (0x0a00_0000 | wave)));

const { retailUiSoundsEnabled, _resetUiSoundTableForTest } = await import("../scene3d/audio/retail_sound_rules.js");
const opt = await import("../plugins/audio_optimistic.js");
const click = await import("../plugins/ui_click_sounds.js");
_resetUiSoundTableForTest();

// ── the flag ─────────────────────────────────────────────────────────────
{
  assert.equal(retailUiSoundsEnabled(""), true);
  assert.equal(retailUiSoundsEnabled("?retailUiSounds=on"), true);
  assert.equal(retailUiSoundsEnabled("?foo=1"), true);
  for (const v of ["off", "OFF", "0", "false"]) {
    assert.equal(retailUiSoundsEnabled(`?retailUiSounds=${v}`), false, v);
  }
  setSearch(null);
  assert.equal(retailUiSoundsEnabled(), true, "no window.location → retail default");
  setSearch("?retailUiSounds=off");
  assert.equal(retailUiSoundsEnabled(), false, "reads window.location.search when no arg");
  setSearch("");
  ok("retailUiSoundsEnabled: default ON; off / 0 / false (any case) disable it");
}

// ── (a) + (b): audio_optimistic UI cues are silent by default ───────────
gestureNotified = true;   // the optimistic path has no gesture coupling
for (const search of [null, "", "?retailItemSounds=off"]) {
  setSearch(search);
  calls.length = 0; resolved.length = 0;
  for (const id of [opt.SOUND.UI_ERROR, opt.SOUND.UI_GRAB, opt.SOUND.UI_RELEASE]) {
    await opt.playOptimistic(id, 0x1234);
    await tick();
    assert.equal(opt.shouldSuppressEcho(id, LPG), false, `0x${id.toString(16)}: no echo claim`);
  }
  opt.playUiError();
  opt.playUiError(LPG);
  await tick();
  const slider = { tagName: "INPUT", type: "range" };
  await fireWin("pointerdown", slider);
  await fireWin("pointerup", slider);
  await fireWin("pointerdown", slider);
  await fireWin("pointerup", { tagName: "DIV" });   // drift-off release
  assert.equal(calls.length, 0, `search=${JSON.stringify(search)}: ${JSON.stringify(calls)}`);
  assert.equal(resolved.length, 0, `nothing resolved: ${JSON.stringify(resolved)}`);
}
ok("default: playOptimistic(0x6D / 0x73 / 0x74), playUiError() and range press/release play nothing");

for (const v of ["off", "0", "false"]) {
  setSearch(`?retailUiSounds=${v}`);
  calls.length = 0;
  opt.playUiError();
  await tick(); await tick();
  assert.equal(centrePlays(0x6D).length, 1, `=${v}: error buzz ${JSON.stringify(calls)}`);
  opt.shouldSuppressEcho(0x6D, LPG);
  const slider = { tagName: "INPUT", type: "range" };
  calls.length = 0;
  await fireWin("pointerdown", slider); await tick();
  await fireWin("pointerup", slider); await tick();
  assert.deepEqual(calls.map((c) => c.wave), [0x0a000073, 0x0a000074], `=${v}: slider ${JSON.stringify(calls)}`);
  opt.shouldSuppressEcho(0x73, LPG); opt.shouldSuppressEcho(0x74, LPG);
}
ok("?retailUiSounds=off / 0 / false: the error buzz and slider grab / release play again");

// ── (c): ui_click_sounds chimes on press ─────────────────────────────────
const unmount = click.mount();
assert.deepEqual(docListeners.map((l) => `${l.type}:${l.capture}`).sort(), ["click:true", "pointerdown:true"]);

const makeButton = ({ disabled = false } = {}) => {
  const el = {
    tagName: "BUTTON",
    dataset: {},
    matches: (sel) => (sel === "[disabled]" ? disabled : false),
    closest: (sel) => (sel.split(",").map((s) => s.trim()).includes("button") ? el : null),
  };
  return el;
};
const plainDiv = { tagName: "DIV", dataset: {}, matches: () => false, closest: () => null };
// An HTML5 drag source: inventory.js makeItemCell (`.hb-inv-slot`,
// `cell.draggable = true`, dragstart handler). `drag: false` is a stub row
// (`cell.draggable = !e.row.stub`). iconIn() is the slot's icon child.
const DRAG_SEL = /^\[draggable=(['"]?)true\1\]$/;
const makeSlot = ({ drag = true } = {}) => {
  const el = {
    tagName: "DIV",
    dataset: {},
    matches: () => false,
    closest: (sel) => {
      if (DRAG_SEL.test(sel.trim())) return drag ? el : null;
      return sel.split(",").map((s) => s.trim()).includes(".hb-inv-slot") ? el : null;
    },
  };
  return el;
};
const iconIn = (slot) => ({ tagName: "DIV", dataset: {}, matches: () => false, closest: (sel) => slot.closest(sel) });

{
  setSearch("");
  gestureNotified = true;
  calls.length = 0;
  await fireDoc("pointerdown", { target: makeButton(), button: 0 });
  assert.equal(centrePlays(0x72).length, 1, `press: ${JSON.stringify(calls)}`);
  assert.equal(calls.length, 1);
  ok("default: a left-button pointerdown on a <button> plays UI_ButtonPress once, from the centre");

  calls.length = 0;
  await fireDoc("click", { target: makeButton(), button: 0 });
  assert.equal(calls.length, 0, `click: ${JSON.stringify(calls)}`);
  ok("default: a click alone plays nothing (the chime already played on press)");

  calls.length = 0;
  await fireDoc("pointerdown", { target: makeButton(), button: 2 });
  await fireDoc("pointerdown", { target: makeButton(), button: 1 });
  assert.equal(calls.length, 0, `right/middle: ${JSON.stringify(calls)}`);
  ok("default: right / middle presses are silent");

  calls.length = 0;
  await fireDoc("pointerdown", { target: makeButton({ disabled: true }), button: 0 });
  await fireDoc("pointerdown", { target: plainDiv, button: 0 });
  assert.equal(calls.length, 0, `disabled/plain: ${JSON.stringify(calls)}`);
  ok("default: disabled buttons and non-interactive targets are silent");

  // One press = one chime even with a nested match (60 ms dedupe kept).
  calls.length = 0;
  clock += 1000;
  for (const l of docListeners.filter((x) => x.type === "pointerdown")) {
    l.fn({ target: makeButton(), button: 0 });
    l.fn({ target: makeButton(), button: 0 });
  }
  await tick();
  assert.equal(calls.length, 1, `dedupe: ${JSON.stringify(calls)}`);
  ok("default: the 60 ms dedupe still collapses a press chain to one chime");
}

{
  // First press of a session: the capture listener runs before the
  // window-bubble autoplay gesture handler (scene3d/index.js). It must
  // notify the gesture itself, or the chime is dropped.
  setSearch("");
  gestureNotified = false;
  order.length = 0; calls.length = 0;
  await fireDoc("pointerdown", { target: makeButton(), button: 0 });
  audioManager.notifyUserGesture();   // the later window-bubble handler
  assert.ok(!order.includes("dropped"), `first press dropped: ${JSON.stringify(order)}`);
  assert.equal(order[0], "gesture", JSON.stringify(order));
  assert.equal(centrePlays(0x72).length, 1);
  ok("first press: notifyUserGesture runs before the chime, so it is not dropped");
}

{
  // Review A-audio-R1: a press on an HTML5 drag source may start a drag, and
  // a drag never fired `click`, so item / hotbar / spell drags were silent.
  // The press chime must not add a sound to every drag; a plain click on the
  // slot still chimes, on `click` as before.
  setSearch("");
  gestureNotified = true;
  const slot = makeSlot();
  calls.length = 0;
  await fireDoc("pointerdown", { target: slot, button: 0 });
  assert.equal(calls.length, 0, `drag-source press: ${JSON.stringify(calls)}`);
  await fireDoc("pointerdown", { target: iconIn(slot), button: 0 });
  assert.equal(calls.length, 0, `drag-source icon press: ${JSON.stringify(calls)}`);
  ok("default: a press on a draggable slot (or its icon) is silent, so a drag stays silent");

  calls.length = 0;
  await fireDoc("pointerdown", { target: slot, button: 0 });
  await fireDoc("click", { target: slot, button: 0 });
  assert.equal(centrePlays(0x72).length, 1, `drag-source click: ${JSON.stringify(calls)}`);
  assert.equal(calls.length, 1);
  ok("default: a plain click on a draggable slot still chimes once, on click");

  calls.length = 0;
  const stub = makeSlot({ drag: false });
  await fireDoc("pointerdown", { target: stub, button: 0 });
  await fireDoc("click", { target: stub, button: 0 });
  assert.equal(centrePlays(0x72).length, 1, `non-draggable slot: ${JSON.stringify(calls)}`);
  assert.equal(calls.length, 1);
  ok("default: a non-draggable slot chimes on press, and its click adds nothing");
}

for (const v of ["off", "0", "false"]) {
  setSearch(`?retailUiSounds=${v}`);
  gestureNotified = true;
  calls.length = 0;
  await fireDoc("pointerdown", { target: makeButton(), button: 0 });
  assert.equal(calls.length, 0, `=${v} press: ${JSON.stringify(calls)}`);
  await fireDoc("click", { target: makeButton(), button: 0 });
  assert.equal(centrePlays(0x72).length, 1, `=${v} click: ${JSON.stringify(calls)}`);
  assert.equal(calls.length, 1);
  calls.length = 0;
  const slot = makeSlot();
  await fireDoc("pointerdown", { target: slot, button: 0 });
  assert.equal(calls.length, 0, `=${v} drag-source press: ${JSON.stringify(calls)}`);
  await fireDoc("click", { target: slot, button: 0 });
  assert.equal(calls.length, 1, `=${v} drag-source click: ${JSON.stringify(calls)}`);
}
ok("?retailUiSounds=off / 0 / false: the chime is back on `click`, not on press");

unmount();
assert.equal(docListeners.length, 0, "unmount removes both listeners");
ok("unmount removes the pointerdown and click listeners");

console.log(`\n${passed} passed`);
