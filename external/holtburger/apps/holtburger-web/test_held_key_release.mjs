// test_held_key_release.mjs — `?heldKeyRelease` (2026-10-07). The owner got
// "stuck autorunning" after inventory drag-and-drop: during a native HTML5
// drag the page gets no keyboard events, so W's key-up was lost and the
// edge-driven cmdInterp lane kept running. The input funnel now remembers
// which keys its raw subscribers saw go down, and when the drag ends it hands
// them the key-up they never got. Headless; ui/input-funnel.js is DOM-free.
//
// Run: node test_held_key_release.mjs
import { InputFunnel, readHeldKeyReleaseFlag } from "./ui/input-funnel.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
}

const key = (k, code) => ({ key: k, code, target: null, repeat: false, preventDefault() {} });
const pointer = (type, buttons) => {
  const ev = new Event(type);
  Object.defineProperty(ev, "buttons", { value: buttons });
  return ev;
};

// A funnel installed on a fake document, with a camera-style keystate
// subscriber (keydown sets, keyup clears) — the shape both real subscribers have.
function rig() {
  const doc = new EventTarget();
  const f = new InputFunnel().install(doc);
  const keys = {};
  const ups = [];
  f.bindRaw("test.keystate", (ev) => { keys[ev.key.toLowerCase()] = true; });
  f.bindRawUp("test.keystate", (ev) => { ups.push(ev.key); keys[ev.key.toLowerCase()] = false; });
  return { doc, f, keys, ups };
}

// 1. The live bug: W down, drag, W released during the drag (lost), drop.
{
  const { doc, f, keys } = rig();
  f.handleKeyDown(key("w", "KeyW"));
  check("W press reaches the keystate", keys.w === true);
  doc.dispatchEvent(new Event("dragstart"));
  doc.dispatchEvent(new Event("drop"));
  check("drop releases the W the browser never released", keys.w === false);
  check("release is counted", f.stats.heldReleased === 1, `heldReleased=${f.stats.heldReleased}`);
  check("lastRelease names the reason and key",
    f.lastRelease?.reason === "drag" && f.lastRelease.keys.join() === "w", JSON.stringify(f.lastRelease));
}

// 2. dragend never reaches document (dragged cell re-rendered away, drop
//    refused): a move with the button still down is mid-drag; one with no
//    button held means the OS drag loop is over.
{
  const { doc, f, keys } = rig();
  f.handleKeyDown(key("w", "KeyW"));
  doc.dispatchEvent(new Event("dragstart"));
  doc.dispatchEvent(pointer("pointermove", 1));
  check("pointermove with the button held does not release", keys.w === true);
  doc.dispatchEvent(pointer("pointermove", 0));
  check("first buttonless pointermove after the drag releases", keys.w === false);
}
{
  const { doc, f, keys } = rig();
  f.handleKeyDown(key("d", "KeyD"));
  doc.dispatchEvent(new Event("dragstart"));
  doc.dispatchEvent(pointer("pointerdown", 1));
  check("a fresh pointerdown after the drag releases", keys.d === false);
}

// 3. Only once per drag, and never without a drag.
{
  const { doc, f, keys, ups } = rig();
  f.handleKeyDown(key("w", "KeyW"));
  doc.dispatchEvent(pointer("pointermove", 0));
  check("no drag → pointer events never release a held key", keys.w === true && ups.length === 0);
  doc.dispatchEvent(new Event("dragstart"));
  doc.dispatchEvent(new Event("dragend"));
  doc.dispatchEvent(new Event("drop"));
  doc.dispatchEvent(pointer("pointermove", 0));
  check("one drag → exactly one synthetic key-up", ups.length === 1, `ups=${ups.length}`);
}

// 4. A real key-up clears the ledger, matched by code (Shift turns "w" into "W").
{
  const { doc, f, ups } = rig();
  f.handleKeyDown(key("w", "KeyW"));
  f.handleKeyUp(key("W", "KeyW"));
  doc.dispatchEvent(new Event("dragstart"));
  doc.dispatchEvent(new Event("drop"));
  check("a real (Shift-cased) key-up leaves nothing to release", ups.length === 1 && f.stats.heldReleased === 0,
    `ups=${ups.length} released=${f.stats.heldReleased}`);
}

// 5. Space is never released by a drag: its release edge is DoJump.
{
  const { doc, f, ups } = rig();
  f.handleKeyDown(key(" ", "Space"));
  f.handleKeyDown(key("w", "KeyW"));
  doc.dispatchEvent(new Event("dragstart"));
  doc.dispatchEvent(new Event("drop"));
  check("space is skipped, W released", ups.join() === "w", `ups=${JSON.stringify(ups)}`);
  check("the ledger is empty afterwards", f._held.size === 0);
}

// 6. A press the gate refused never reached the subscribers — nothing to undo.
{
  const { doc, f, ups } = rig();
  f.setGate(() => false);
  f.handleKeyDown(key("w", "KeyW"));
  doc.dispatchEvent(new Event("dragstart"));
  doc.dispatchEvent(new Event("drop"));
  check("gated press is not released", ups.length === 0);
}

// 7. Lost-key-up detector: a fresh press of a key the ledger still holds.
{
  const { doc, f } = rig();
  const warns = [];
  const realWarn = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    f.handleKeyDown(key("w", "KeyW"));
    f.handleKeyDown({ ...key("w", "KeyW"), repeat: true });
    check("OS autorepeat is not a lost key-up", f.stats.lostKeyUps === 0);
    doc.dispatchEvent(new Event("pointerlockchange"));
    f.handleKeyDown(key("w", "KeyW"));
  } finally {
    console.warn = realWarn;
  }
  check("fresh press while still held → lost key-up counted", f.stats.lostKeyUps === 1, `lost=${f.stats.lostKeyUps}`);
  check("the detector names the key", f.lastLostKeyUp?.code === "KeyW");
  check("the detector lists what happened since the press",
    f.lastLostKeyUp?.risks?.some((r) => r.type === "pointerlock"), JSON.stringify(f.lastLostKeyUp));
  check("one warning, naming the key", warns.length === 1 && warns[0].includes("lost key-up: KeyW"), JSON.stringify(warns));
}

// 8. A native context menu takes the keyboard too. Only when it really opens
//    (no handler prevented it) are the held keys released.
{
  const savedWindow = globalThis.window;
  globalThis.window = new EventTarget();
  try {
    const { f, keys } = rig();
    f.handleKeyDown(key("w", "KeyW"));
    const prevented = new Event("contextmenu", { cancelable: true });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    check("a prevented context menu (game handled it) releases nothing", keys.w === true);
    window.dispatchEvent(new Event("contextmenu", { cancelable: true }));
    check("a native context menu releases the held W", keys.w === false);
    check("…with reason contextmenu", f.lastRelease?.reason === "contextmenu", JSON.stringify(f.lastRelease));
    f.handleKeyDown(key("a", "KeyA"));
    window.dispatchEvent(new Event("blur"));
    check("blur makes the ledger forget (subscribers release on their own)", f._held.size === 0);
  } finally {
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  }
}

// 9. Flag reader.
check("flag default ON", readHeldKeyReleaseFlag("") === true);
check("?heldKeyRelease=off disables", readHeldKeyReleaseFlag("?heldKeyRelease=off") === false);
check("?heldKeyRelease=0 disables", readHeldKeyReleaseFlag("?heldKeyRelease=0") === false);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
