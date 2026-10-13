// tests/movement_key_of.test.mjs — app-loop-2 (2026-10-13): the movement
// keys, the combat toggle and the camera-mode key resolve by PHYSICAL key
// (KeyboardEvent.code), not by the character the layout types (retail read
// DirectInput scan codes: CInputManager_WIN32::AddDevice → c_dfDIKeyboard).
//
//   [1] movementKeyOf: QWERTY / AZERTY / Cyrillic presses, the empty-code
//       synthetic events (virtual keypad, harness), Space / Shift → null.
//   [2] `?movementKeysByCode=off` restores the legacy ev.key resolution
//       (checked case for case against the old expression).
//   [3] isCombatToggleKey (Backquote, not Shift+Backquote) / isCameraModeKey.
//   [4] edge rig: a funnel subscriber shaped like index.html's movement
//       branch forwards CMD_INTERP_ACTIONS edges — AZERTY press, release
//       after a mid-hold layout switch, the funnel's synthetic drag release.
//   [5] static wiring: index.html __gameplayKeyDown / __gameplayKeyUp and the
//       combat toggle, camera.js onKeyDown / onKeyUp / the C toggle, and
//       picking.js onKeyDownAbortCharge use the helpers, not ev.key.
//
// Run from apps/holtburger-web/:  node tests/movement_key_of.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

const MK = await import("../ui/movement_keys.js");
const { InputFunnel } = await import("../ui/input-funnel.js");

const ev = (code, key, extra = {}) => ({ code, key, repeat: false, target: null, preventDefault() {}, ...extra });

// ── [1] movementKeyOf ────────────────────────────────────────────────────
test("[1] movementKeyOf resolves the physical key", () => {
  const on = (e) => MK.movementKeyOf(e, true);
  assert.equal(on(ev("KeyW", "w")), "w", "QWERTY W");
  assert.equal(on(ev("KeyW", "W")), "w", "Shift / CapsLock W");
  assert.equal(on(ev("KeyW", "z")), "w", "AZERTY: physical W types z");
  assert.equal(on(ev("KeyW", "ц")), "w", "Cyrillic: physical W types ц");
  assert.equal(on(ev("KeyW", "Process")), "w", "IME composing");
  assert.equal(on(ev("KeyZ", "w")), null, "AZERTY bottom-left types w but is not W");
  assert.equal(on(ev("KeyQ", "a")), "q", "AZERTY: physical Q types a");
  assert.equal(on(ev("KeyA", "q")), "a", "AZERTY: physical A types q");
  assert.equal(on(ev("KeyS", "ы")), "s");
  assert.equal(on(ev("KeyD", "в")), "d");
  assert.equal(on(ev("KeyE", "у")), "e");
  assert.equal(on(ev("", "W")), "w", "virtual keypad / harness: no code → ev.key");
  assert.equal(on({ key: "d" }), "d", "code absent → ev.key");
  assert.equal(on(ev("", "x")), null, "no code, not a movement letter");
  assert.equal(on(ev("Space", " ")), null, "Space is not a movement key");
  assert.equal(on(ev("ShiftLeft", "Shift")), null, "Shift is not a movement key");
  assert.equal(on(ev("ArrowUp", "ArrowUp")), null, "arrows are not movement keys");
  assert.equal(on(ev("constructor", "w")), null, "no prototype leak");
  assert.equal(on(null), null);
  assert.equal(on(undefined), null);
  assert.equal(on({ code: "", key: undefined }), null, "Chrome autofill keydown (no key)");
});

test("[1] default argument follows ?movementKeysByCode (default ON under node)", () => {
  MK._resetMovementKeysByCodeForTest();
  assert.equal(MK.movementKeysByCodeOn(), true);
  assert.equal(MK.movementKeyOf(ev("KeyW", "z")), "w");
  MK._resetMovementKeysByCodeForTest();
});

// ── [2] the escape flag ─────────────────────────────────────────────────
test("[2] ?movementKeysByCode is DEFAULT-ON; off/0/false opt out", () => {
  assert.equal(MK.readMovementKeysByCodeFlag(""), true);
  assert.equal(MK.readMovementKeysByCodeFlag("?foo=1"), true);
  for (const v of ["off", "OFF", "0", "false"]) {
    assert.equal(MK.readMovementKeysByCodeFlag(`?movementKeysByCode=${v}`), false, v);
  }
  for (const v of ["on", "1", "true", ""]) {
    assert.equal(MK.readMovementKeysByCodeFlag(`?movementKeysByCode=${v}`), true, v);
  }
});

test("[2] flag off = the legacy `ev.key.toLowerCase()` + six-letter Set, case for case", () => {
  const legacySet = new Set(["w", "a", "s", "d", "q", "e"]);
  const legacy = (e) => {
    const k = (e.key || "").toLowerCase();
    return legacySet.has(k) ? k : null;
  };
  const cases = [
    ev("KeyW", "w"), ev("KeyW", "W"), ev("KeyW", "z"), ev("KeyW", "ц"), ev("KeyZ", "w"),
    ev("KeyQ", "a"), ev("KeyA", "q"), ev("", "W"), ev("Space", " "), ev("ShiftLeft", "Shift"),
    ev("KeyC", "c"), ev("Backquote", "`"), ev("ArrowLeft", "ArrowLeft"),
  ];
  for (const c of cases) {
    assert.equal(MK.movementKeyOf(c, false), legacy(c), `${c.code}/${c.key}`);
  }
});

// ── [3] the two toggles ─────────────────────────────────────────────────
test("[3] isCombatToggleKey: physical Backquote (retail DIK_GRAVE)", () => {
  const on = (e) => MK.isCombatToggleKey(e, true);
  assert.equal(on(ev("Backquote", "`")), true, "US QWERTY");
  assert.equal(on(ev("Backquote", "²")), true, "AZERTY");
  assert.equal(on(ev("Backquote", "Dead")), true, "QWERTZ dead ^");
  assert.equal(on(ev("Backquote", "`", { ctrlKey: true })), true, "Ctrl+` (legacy matched it too)");
  assert.equal(on(ev("Backquote", "~", { shiftKey: true })), false, "Shift+` is ~ — never the toggle");
  assert.equal(on(ev("Digit7", "`")), false, "AZERTY AltGr+7 types ` but is not the key");
  assert.equal(on(ev("", "`")), true, "synthetic event without code → ev.key");
  assert.equal(on(ev("KeyW", "w")), false);
  assert.equal(on(null), false);
  // flag off: the legacy `ev.key === "`"` exactly
  assert.equal(MK.isCombatToggleKey(ev("Backquote", "²"), false), false);
  assert.equal(MK.isCombatToggleKey(ev("Digit7", "`"), false), true);
  assert.equal(MK.isCombatToggleKey(ev("Backquote", "~", { shiftKey: true }), false), false);
});

test("[3] isCameraModeKey: physical C", () => {
  const on = (e) => MK.isCameraModeKey(e, true);
  assert.equal(on(ev("KeyC", "c")), true);
  assert.equal(on(ev("KeyC", "C")), true, "Shift+C (legacy lower-cased it too)");
  assert.equal(on(ev("KeyC", "с")), true, "Cyrillic");
  assert.equal(on(ev("KeyI", "c")), false, "Dvorak: C is on the I position");
  assert.equal(on(ev("", "c")), true, "no code → ev.key");
  assert.equal(on(null), false);
  // flag off: the legacy `(ev.key || "").toLowerCase() === "c"`
  assert.equal(MK.isCameraModeKey(ev("KeyI", "c"), false), true);
  assert.equal(MK.isCameraModeKey(ev("KeyC", "с"), false), false);
});

// ── [4] the edge rig ────────────────────────────────────────────────────
const HTML = readFileSync(resolvePath(APP, "index.html"), "utf8");

function cmdInterpActions() {
  const m = HTML.match(/const CMD_INTERP_ACTIONS = \{([\s\S]*?)\};/);
  assert.ok(m, "index.html declares CMD_INTERP_ACTIONS");
  const out = {};
  for (const e of m[1].matchAll(/(?:"([^"]*)"|([a-z]+))\s*:\s*0x([0-9a-f]+)/gi)) {
    out[e[1] ?? e[2]] = Number.parseInt(e[3], 16);
  }
  return out;
}

/** A funnel with a raw subscriber shaped like index.html's movement branch. */
function rig() {
  const actions = cmdInterpActions();
  const movementKeys = new Set(["w", "a", "s", "d", "q", "e"]);
  const keyState = {};
  const edges = [];
  const forward = (k, down) => {
    const a = actions[k];
    if (a != null) edges.push([a, down]);
  };
  const funnel = new InputFunnel().setGate(() => true);
  funnel.bindRaw("index.gameplay", (e) => {
    const k = MK.movementKeyOf(e, true);
    if (movementKeys.has(k)) {
      if (!e.repeat) forward(k, true);
      keyState[k] = true;
    }
  }, { priority: 100 });
  funnel.bindRawUp("index.gameplay", (e) => {
    const k = MK.movementKeyOf(e, true);
    if (movementKeys.has(k)) {
      forward(k, false);
      keyState[k] = false;
    }
  });
  return { funnel, keyState, edges };
}

test("[4] AZERTY: physical W ('z') forwards WalkForward 0x29; physical Z ('w') forwards nothing", () => {
  const { funnel, keyState, edges } = rig();
  funnel.handleKeyDown(ev("KeyW", "z"));
  assert.deepEqual(edges, [[0x29, true]]);
  assert.equal(keyState.w, true);
  funnel.handleKeyUp(ev("KeyW", "z"));
  funnel.handleKeyDown(ev("KeyZ", "w"));
  funnel.handleKeyUp(ev("KeyZ", "w"));
  assert.deepEqual(edges, [[0x29, true], [0x29, false]]);
  assert.equal(keyState.w, false);
});

test("[4] layout switch mid-hold: the release edge still fires (no stuck run)", () => {
  const { funnel, keyState, edges } = rig();
  funnel.handleKeyDown(ev("KeyW", "w"));
  funnel.handleKeyDown(ev("KeyW", "w", { repeat: true }));
  // Alt+Shift → Russian while W is held; the key-up reports 'ц'.
  funnel.handleKeyUp(ev("KeyW", "ц"));
  assert.deepEqual(edges, [[0x29, true], [0x29, false]], "one press edge, one release edge");
  assert.equal(keyState.w, false);
});

test("[4] Cyrillic layout drives all six movement actions", () => {
  const { funnel, edges } = rig();
  const keys = [["KeyW", "ц"], ["KeyS", "ы"], ["KeyD", "в"], ["KeyA", "ф"], ["KeyE", "у"], ["KeyQ", "й"]];
  for (const [code, key] of keys) {
    funnel.handleKeyDown(ev(code, key));
    funnel.handleKeyUp(ev(code, key));
  }
  assert.deepEqual(edges.filter(([, d]) => d).map(([a]) => a), [0x29, 0x2a, 0x2c, 0x2d, 0x2e, 0x2f]);
  assert.equal(edges.filter(([, d]) => !d).length, 6);
});

test("[4] the funnel's synthetic drag release reaches the movement branch", () => {
  const { funnel, keyState, edges } = rig();
  funnel.handleKeyDown(ev("KeyW", "z"));
  funnel.releaseHeld("drag");
  assert.deepEqual(edges, [[0x29, true], [0x29, false]]);
  assert.equal(keyState.w, false);
});

test("[4] virtual keypad (key only, empty code) still presses and releases", () => {
  const { funnel, edges } = rig();
  funnel.handleKeyDown(ev("", "w"));
  funnel.handleKeyUp(ev("", "w"));
  assert.deepEqual(edges, [[0x29, true], [0x29, false]]);
});

// ── [5] static wiring ───────────────────────────────────────────────────
/** Body of `const <name> = (ev) => {` up to its closing `};` at that indent. */
function arrowBody(src, name) {
  const re = new RegExp(`\\n( *)const ${name} = \\(ev\\) => \\{`);
  const m = re.exec(src);
  assert.ok(m, `${name} present`);
  const end = src.indexOf(`\n${m[1]}};`, m.index + m[0].length);
  assert.ok(end > 0, `${name} closes`);
  return src.slice(m.index, end);
}
/** Body of `function <name>(ev) {` up to its closing `}` at that indent. */
function fnBody(src, name) {
  const re = new RegExp(`\\n( *)function ${name}\\(ev\\) \\{`);
  const m = re.exec(src);
  assert.ok(m, `${name} present`);
  const end = src.indexOf(`\n${m[1]}}`, m.index + m[0].length);
  assert.ok(end > 0, `${name} closes`);
  return src.slice(m.index, end);
}
const LEGACY_KEY = /ev\.key\.toLowerCase\(\)|\(ev\.key \|\| ""\)\.toLowerCase\(\)/;

test("[5] index.html: gameplay keydown / keyup resolve movement through movementKeyOf", () => {
  assert.match(HTML, /movementKeyOf as __movementKeyOf/);
  assert.match(HTML, /from "\.\/ui\/movement_keys\.js"/);
  for (const name of ["__gameplayKeyDown", "__gameplayKeyUp"]) {
    const body = arrowBody(HTML, name);
    assert.match(body, /const k = __movementKeyOf\(ev\);/, name);
    assert.doesNotMatch(body, LEGACY_KEY, `${name} no longer derives the movement key from ev.key`);
  }
});

test("[5] index.html: the combat toggle matches the physical key", () => {
  const body = arrowBody(HTML, "__gameplayKeyDown");
  assert.match(body, /if \(__isCombatToggleKey\(ev\) && handle\)/);
  assert.doesNotMatch(body, /ev\.key === "`"/);
});

test("[5] camera.js: keystate mirror + C toggle use the helpers", () => {
  const CAM = readFileSync(resolvePath(APP, "scene3d/camera.js"), "utf8");
  assert.match(CAM, /import \{ movementKeyOf, isCameraModeKey \} from "\.\.\/ui\/movement_keys\.js";/);
  const install = CAM.slice(CAM.indexOf("  _installKeyListeners() {"), CAM.indexOf("  _installModeToggle() {"));
  for (const name of ["onKeyDown", "onKeyUp"]) {
    const body = arrowBody(install, name);
    assert.match(body, /const k = movementKeyOf\(ev\);/, name);
    assert.doesNotMatch(body, LEGACY_KEY, name);
  }
  const toggle = CAM.slice(CAM.indexOf("  _installModeToggle() {"));
  const body = arrowBody(toggle, "onKeyDown");
  assert.match(body, /isCameraModeKey\(ev\) && !ev\.repeat/);
  assert.doesNotMatch(body, LEGACY_KEY);
});

test("[5] picking.js: onKeyDownAbortCharge resolves movement through movementKeyOf", () => {
  const PICK = readFileSync(resolvePath(APP, "scene3d/picking.js"), "utf8");
  assert.match(PICK, /import \{ movementKeyOf \} from "\.\.\/ui\/movement_keys\.js";/);
  const body = fnBody(PICK, "onKeyDownAbortCharge");
  assert.match(body, /const mk = movementKeyOf\(ev\);/);
  // Only Shift + arrows still come from ev.key; the six letters must not.
  const set = PICK.match(/const ABORT_KEYS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(set, "ABORT_KEYS present");
  for (const k of ["w", "a", "s", "d", "q", "e"]) {
    assert.ok(!new RegExp(`"${k}"`).test(set[1]), `ABORT_KEYS no longer lists "${k}"`);
  }
  assert.match(set[1], /"shift"/);
});
