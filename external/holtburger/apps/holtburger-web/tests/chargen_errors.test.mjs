// tests/chargen_errors.test.mjs — maps-chargen-barber-2 (2026-10-13).
//
// Retail gmCharGenMainUI::RecvNotice_CharGenVerificationResponse
// (acclient.c:278557) shows a 0xF643 rejection as an ID_Character_Err_*
// sentence: 3 → NameReserved, 4 → NameBanned, 7 → NameAdminDenied, anything
// else → NameDBDown, each looked up with compute_str_hash (acclient.c:78974)
// in StringTable 0x23000002 (table enum 0x10000002). holtburger showed the
// Rust enum label ("NameInUse", "Pending", "Corrupt") on the wizard's Failed
// page and on the create status line, and offered "Back to skills" for a
// name problem whose fix is on page 1.
//
// CONTRACT
//   [1] chargenErrorToken: codes 0..8 and 99 → retail arms; Ok (1) → null.
//   [2] computeStrHash equals holtburger-dat spellbase_string_hash /
//       retail compute_str_hash for the four tokens. The constants are the
//       keys of those strings in ~/ac_base_dats/client_local_English.dat
//       StringTable 0x23000002 (read with a one-off script, 289 entries).
//   [3] chargenErrorInfo: DAT text when the table is loaded, else English.
//   [4] client_events kind=6: retail status line + bus `message` /
//       `nameError`, `reason` still the raw label.
//   [5] the wizard's Failed page shows the retail text; a name error offers
//       only "Back", which lands on Heritage (the name field) with the name
//       kept.
//
// NEGATIVE CONTROLS
//   - utils::string_hash (rotate-xor) gives different keys — the trap the
//     verifier flagged.
//   - ?retailCharErrors=off → raw label line, bus payload { code, reason }
//     only, the Failed page keeps "Back to skills" / "Start over".
//
// Run from apps/holtburger-web/:  node tests/chargen_errors.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (e) { failed += 1; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

/* ── a DOM small enough for the wizard overlay ─────────────────────────── */

function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    className: "",
    id: "",
    textContent: "",
    value: "",
    disabled: false,
    appendChild(c) { if (c) { c.parentNode = el; el.children.push(c); } return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    click() { for (const fn of listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} }); },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  // render() clears the body / footer with `innerHTML = ""`.
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set: (v) => { html = String(v); for (const c of el.children) c.parentNode = null; el.children.length = 0; },
  });
  return el;
}

function walk(el, out = []) {
  out.push(el);
  for (const c of el.children || []) walk(c, out);
  return out;
}

const docBody = makeEl("body");
globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  createElement: makeEl,
  createElementNS: () => makeEl("svg"),
  getElementById: () => null,
  head: makeEl("head"),
  body: docBody,
  addEventListener() {},
  removeEventListener() {},
};

const R = await import("../app/login_ui_rules.js");
const S = await import("../ui/ac_strings.js");
const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

/* ── [1] the retail code → token switch ───────────────────────────────── */

console.log("[1] chargenErrorToken");

await check("Ok (1) has no error; 3 / 4 / 7 pick their own token", () => {
  assert.equal(R.chargenErrorToken(1), null);
  assert.equal(R.chargenErrorToken(3), "ID_Character_Err_NameReserved");
  assert.equal(R.chargenErrorToken(4), "ID_Character_Err_NameBanned");
  assert.equal(R.chargenErrorToken(7), "ID_Character_Err_NameAdminDenied");
});

await check("every other code (0, 2, 5, 6, 8, 99) is the default NameDBDown arm", () => {
  for (const c of [0, 2, 5, 6, 8, 99, -1, undefined]) {
    assert.equal(R.chargenErrorToken(c), "ID_Character_Err_NameDBDown", String(c));
  }
  assert.equal(R.chargenErrorInfo(1), null, "Ok yields no rejection");
});

/* ── [2] compute_str_hash port ────────────────────────────────────────── */

console.log("[2] computeStrHash");

// Keys of the four strings in client_local_English.dat StringTable 0x23000002.
const KEYS = {
  ID_Character_Err_NameReserved: 0x0E1EB664,
  ID_Character_Err_NameBanned: 0x09D6D694,
  ID_Character_Err_NameAdminDenied: 0x003AD454,
  ID_Character_Err_NameDBDown: 0x09D434FE,
};

await check("the four tokens hash to their DAT keys", () => {
  for (const [token, key] of Object.entries(KEYS)) {
    assert.equal(R.computeStrHash(token), key, token);
  }
});

await check("signed-char fold and the empty string match spellbase_string_hash", () => {
  assert.equal(R.computeStrHash(""), 0);
  // 0xE9 is a negative char: 0xFFFFFFE9 folds to 0x0FFFFF19.
  assert.equal(R.computeStrHash("é"), 0x0FFFFF19);
  assert.equal(R.computeStrHash("Café"), 0x00049749);
});

await check("negative control: utils::string_hash (rotate-xor) gives a different key", () => {
  const rotXor = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i) & 0xFF;
      if (c >= 0x80) c -= 0x100;
      h = (((h << 4) | (h >>> 28)) ^ c) >>> 0;
    }
    return (h & 0x0FFFFFFF) >>> 0;
  };
  assert.equal(rotXor("ID_Character_Err_NameReserved"), 0x0310EEA1);
  assert.notEqual(rotXor("ID_Character_Err_NameReserved"), KEYS.ID_Character_Err_NameReserved);
});

/* ── [3] text resolution ──────────────────────────────────────────────── */

console.log("[3] chargenErrorInfo");

await check("English fallback without a loaded table", () => {
  assert.equal(R.chargenErrorInfo(3).text, "The name you have selected is already in use.");
  assert.equal(R.chargenErrorInfo(4).text, "Sorry, but that name is not permitted. Please choose another.");
  assert.equal(R.chargenErrorInfo(7).text, "Sorry, but you do not have the privileges to make an administrator character.");
  assert.equal(R.chargenErrorInfo(5).text, "The server cannot create your new character at this time. Please try again later.");
  assert.equal(R.chargenErrorInfo(3, () => null).text, "The name you have selected is already in use.", "lookup miss");
  assert.equal(R.chargenErrorInfo(3, () => { throw new Error("x"); }).text, "The name you have selected is already in use.", "lookup throws");
});

await check("the lookup is asked for table 0x23000002 and the hashed key", () => {
  const asked = [];
  const info = R.chargenErrorInfo(4, (t, k) => { asked.push([t, k]); return "DAT banned"; });
  assert.deepEqual(asked, [[0x23000002, KEYS.ID_Character_Err_NameBanned]]);
  assert.equal(info.text, "DAT banned");
  assert.equal(info.stringId, KEYS.ID_Character_Err_NameBanned);
});

await check("nameError marks 3 / 4 / 7 only", () => {
  for (const c of [3, 4, 7]) assert.equal(R.chargenErrorInfo(c).nameError, true, String(c));
  for (const c of [0, 2, 5, 6, 8, 99]) assert.equal(R.chargenErrorInfo(c).nameError, false, String(c));
});

/* ── [4] client_events kind=6 ─────────────────────────────────────────── */

console.log("[4] client_events CHARACTER_CREATE_FAILED");

const handlers = {};
const emitted = [];
const CATALOG = {
  heritages: [{
    heritageId: 1,
    name: "Aluvian",
    attributeCredits: 330,
    skillCredits: 50,
    templates: [{
      templateOption: 0, name: "Soldier",
      strength: 40, endurance: 40, coordination: 40,
      quickness: 40, focus: 40, self: 40,
      skills: [],
    }],
    genders: [{
      genderId: 1, name: "Female",
      appearance: {
        eyeStripCount: 1, noseStripCount: 1, mouthStripCount: 1,
        hairColorCount: 1, eyeColorCount: 1, hairStyleCount: 1,
        headgearCount: 0, clothingColorCount: 1,
        shirtCount: 1, pantsCount: 1, footwearCount: 1,
      },
    }],
    startAreas: [{ startAreaId: 0, name: "Holtburg" }],
    skills: [],
  }],
  skills: [],
};
const client = {
  characters: { getCatalog: () => CATALOG, createCharacter() {} },
  events: {
    on(name, fn) { handlers[name] = fn; },
    off(name) { delete handlers[name]; },
    emit(name, payload) { emitted.push([name, payload]); handlers[name]?.({ detail: payload }); },
  },
};
window.__pluginClient = client;

function createFailed(code, label) {
  const D = {
    loginStatus: { innerHTML: "" },
    createStatus: { innerHTML: "" },
    createBtn: { disabled: true },
    __resetEntDrainPending() {}, setLocalPlayerGuid() {}, getLocalPlayerGuid: () => null,
    setBootState() {}, EVT_GUARD_ON: false, CMD_INTERP_ON: false, CAST_MOVE_ON: false,
  };
  const evt = { kind: ClientEventKind.CHARACTER_CREATE_FAILED, u32Payload: code, u32Payload2: 0, stringPayload: label, free() {} };
  emitted.length = 0;
  dispatchClientEvent(evt, D);
  return D;
}

await check("code 3 → retail sentence on the status line; bus adds message + nameError", () => {
  const D = createFailed(3, "NameInUse");
  assert.match(D.createStatus.innerHTML, /\[FAIL\]<\/span> The name you have selected is already in use\./);
  assert.doesNotMatch(D.createStatus.innerHTML, /NameInUse/);
  assert.equal(D.createBtn.disabled, false);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], ["characterCreateFailed", {
    code: 3, reason: "NameInUse",
    message: "The name you have selected is already in use.", nameError: true,
  }]);
});

await check("code 2 (Pending — ACE's disabled-Olthoi answer) → NameDBDown text, not a name error", () => {
  const D = createFailed(2, "Pending");
  assert.match(D.createStatus.innerHTML, /The server cannot create your new character at this time\./);
  assert.equal(emitted[0][1].nameError, false);
  assert.equal(emitted[0][1].reason, "Pending");
});

await check("code 0 (an unknown code, which the unpack now maps to Undef) → NameDBDown", () => {
  const D = createFailed(0, "Undef");
  assert.match(D.createStatus.innerHTML, /The server cannot create your new character at this time\./);
});

await check("once StringTable 0x23000002 is loaded the DAT text wins", async () => {
  window.__hbWasm = {
    fetch_string_table: async (id) => JSON.stringify(id === 0x23000002
      ? [[KEYS.ID_Character_Err_NameBanned, "DAT: name not permitted"]]
      : []),
  };
  try {
    const map = await S.loadStringTable(0x23000002);
    assert.equal(map.size, 1);
    const D = createFailed(4, "NameBanned");
    assert.match(D.createStatus.innerHTML, /DAT: name not permitted/);
    assert.equal(emitted[0][1].message, "DAT: name not permitted");
    // A key missing from the table still falls back to English.
    const D2 = createFailed(3, "NameInUse");
    assert.match(D2.createStatus.innerHTML, /already in use/);
  } finally {
    delete window.__hbWasm;
  }
});

await check("negative control: ?retailCharErrors=off → raw label line, payload { code, reason }", () => {
  location.search = "?retailCharErrors=off";
  try {
    const D = createFailed(3, "NameInUse");
    assert.match(D.createStatus.innerHTML, /CharacterCreate rejected: <code>NameInUse<\/code> \(code 3\)\./);
    assert.deepEqual(emitted[0], ["characterCreateFailed", { code: 3, reason: "NameInUse" }]);
  } finally {
    location.search = "";
  }
});

/* ── [5] the wizard's Failed page ─────────────────────────────────────── */

console.log("[5] wizard Failed page");

const src = readFileSync(path.join(APP, "plugins", "character-creation.js"), "utf8");
// The plugin keeps exactly its two static imports (the reopen test splices
// it with these stubs); the retail text arrives on the bus payload.
const body = spliceModule(src, {
  label: "plugins/character-creation.js",
  provided: [],
  stubs: {
    setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
    fetchIconDataUrlShared: "() => Promise.resolve(null)",
  },
});
// eslint-disable-next-line no-new-func
const mod = new Function(body + "\nreturn { openWizard, closeWizard };\n")();

function failedPage(code, label) {
  mod.closeWizard();
  const w = mod.openWizard({ client });
  assert.ok(w, "wizard opens with the fixture catalog");
  w._state.name = "Delulu";
  w._state.wizard = "submitting"; // as after Create (doSubmit already sent)
  createFailed(code, label);
  assert.equal(w._state.wizard, "failed");
  const overlay = docBody.children[docBody.children.length - 1];
  const els = walk(overlay);
  const buttons = els.filter((e) => e.tagName === "BUTTON" && /hb-cc-btn/.test(e.className)
    && e.parentNode?.className === "hb-cc-footer");
  const error = els.find((e) => e.className === "hb-cc-error");
  return { w, buttons, error };
}

await check("name error (3): retail text, a single primary Back to Heritage, name kept", () => {
  const { w, buttons, error } = failedPage(3, "NameInUse");
  assert.equal(error?.textContent, "The name you have selected is already in use.");
  assert.deepEqual(buttons.map((b) => b.textContent), ["← Back"]);
  assert.match(buttons[0].className, /primary/);
  buttons[0].click();
  assert.equal(w._state.wizard, "heritage", "Back goes to page 1, where the name field is");
  assert.equal(w._state.name, "Delulu", "the choices are kept");
});

await check("banned (4) and admin-denied (7) are name errors too", () => {
  for (const [code, label, re] of [[4, "NameBanned", /not permitted/], [7, "AdminPrivilegeDenied", /administrator character/]]) {
    const { buttons, error } = failedPage(code, label);
    assert.match(error?.textContent ?? "", re, label);
    assert.deepEqual(buttons.map((b) => b.textContent), ["← Back"], label);
  }
});

await check("other codes (5 Corrupt) keep Back to skills / Start over, with the retail text", () => {
  const { w, buttons, error } = failedPage(5, "Corrupt");
  assert.equal(error?.textContent, "The server cannot create your new character at this time. Please try again later.");
  assert.deepEqual(buttons.map((b) => b.textContent), ["Back to skills", "Start over"]);
  buttons[0].click();
  assert.equal(w._state.wizard, "skills");
});

await check("negative control: ?retailCharErrors=off → raw label and the old buttons", () => {
  location.search = "?retailCharErrors=off";
  try {
    const { buttons, error } = failedPage(3, "NameInUse");
    assert.equal(error?.textContent, "NameInUse");
    assert.deepEqual(buttons.map((b) => b.textContent), ["Back to skills", "Start over"]);
  } finally {
    location.search = "";
  }
});

await check("a later local validation failure clears the name-error buttons", () => {
  const { w } = failedPage(3, "NameInUse");
  w._state.wizard = "summary";
  w._state.heritageId = 999; // doSubmit: "Unknown heritage; cannot submit."
  w.transition("submit");
  assert.equal(w._state.wizard, "failed");
  assert.equal(w._state.errorNameField, false);
  assert.equal(w._state.errorMessage, "Unknown heritage; cannot submit.");
});

mod.closeWizard();

console.log(`\nchargen_errors: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
