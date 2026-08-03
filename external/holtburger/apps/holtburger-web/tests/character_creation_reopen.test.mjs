// tests/character_creation_reopen.test.mjs — round-9 review, finding R9-5.
//
// `plugins/character-creation.js` keeps the wizard as a module singleton:
//
//     let _wizard = null;                        // :583
//     export function openWizard(ctx) {
//       if (_wizard) return _wizard;             // "already open — bring to front"
//       ...
//       _wizard = createWizardInstance(...);
//
// but the CANCEL / CLOSE path inside the instance tore the DOM down without
// releasing the singleton:
//
//     if (next === WizardState.NotStarted) {
//       destroy();                               // :732 — removes the overlay
//       ctx?.onCancel?.();
//       return;
//     }
//
// `_wizard` was only nulled by the module-level `closeWizard()` (:622-625),
// which index.html calls ONLY on the success path (index.html:6356). Every
// other exit — the "×" button (:672), "Cancel" (:996) and the Success dialog's
// OK (:1445, `transition("close")`) — reaches NotStarted through `transition`.
//
// So: open char-gen, click Cancel, click "New Character" again -> openWizard()
// returns the DESTROYED instance whose overlay is already detached, and the
// wizard can never be opened again for the life of the page. index.html's
// onCancel handler (:6363) is a no-op, so nothing else recovers it.
//
// CONTRACT
//   [1] after a cancel, openWizard() builds a NEW instance and attaches a
//       fresh overlay;
//   [2] the release is IDENTITY-guarded: a stale instance transitioning to
//       NotStarted must not evict a newer wizard that has since been opened.
//   [3] closeWizard() still works and stays idempotent.
//
// NEGATIVE CONTROL
//   A bare `_wizard = null` in the NotStarted branch passes [1] and [3] but
//   FAILS [2] — exactly the same class as the `entityMap.has(guid)` vs
//   `entityMap.get(guid) !== inst` distinction used elsewhere in this tree.
//
// Run from apps/holtburger-web/:
//   node tests/character_creation_reopen.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spliceModule } from "../harness/lib/splice_module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

/* ── a DOM small enough to build the wizard overlay in ────────────────── */

let attachedOverlays = 0;

function makeEl(tag) {
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
    innerHTML: "",
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
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  return el;
}

const docBody = makeEl("body");
docBody.appendChild = (c) => {
  if (c) { c.parentNode = docBody; docBody.children.push(c); attachedOverlays += 1; }
  return c;
};
docBody.removeChild = (c) => {
  const i = docBody.children.indexOf(c);
  if (i >= 0) { docBody.children.splice(i, 1); attachedOverlays -= 1; }
  if (c) c.parentNode = null;
  return c;
};

globalThis.document = {
  createElement: makeEl,
  createElementNS: () => makeEl("svg"),
  getElementById: () => null,
  head: makeEl("head"),
  body: docBody,
  addEventListener() {},
  removeEventListener() {},
};

/* ── a client with a minimal char-gen catalog ─────────────────────────── */

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
  characters: { getCatalog: () => CATALOG },
  events: { on() {}, off() {} },
};

globalThis.window = { __pluginClient: client };

/* ── load the plugin ──────────────────────────────────────────────────── */

const src = readFileSync(path.join(APP, "plugins", "character-creation.js"), "utf8");
const body = spliceModule(src, {
  label: "plugins/character-creation.js",
  provided: [],
  stubs: {
    setAcText: "(el, text) => { if (el) el.textContent = String(text ?? ''); }",
    fetchIconDataUrlShared: "() => Promise.resolve(null)",
  },
});
// eslint-disable-next-line no-new-func
const mod = new Function(
  body + "\nreturn { openWizard, closeWizard, __peekWizard: () => _wizard };\n",
)();

/* ── [1] cancel then reopen ───────────────────────────────────────────── */

const w1 = mod.openWizard({ client });
assert.ok(w1, "wizard must open with the fixture catalog");
assert.equal(attachedOverlays, 1, "one overlay attached on open");

let cancelCalls = 0;
w1._cancelProbe = true;
w1.transition("cancel"); // what the × and Cancel buttons dispatch

check("cancel detaches the overlay", () => {
  assert.equal(attachedOverlays, 0, "overlay should be removed on cancel");
});

check("cancel releases the module singleton", () => {
  assert.equal(
    mod.__peekWizard(),
    null,
    "_wizard still points at the destroyed instance — openWizard()'s " +
    "'already open' short-circuit will return it forever",
  );
});

const w2 = mod.openWizard({ client, onCancel: () => { cancelCalls += 1; } });
check("the wizard can be re-opened after a cancel", () => {
  assert.ok(w2, "openWizard returned null/undefined after a cancel");
  assert.notEqual(w2, w1, "openWizard handed back the OLD, destroyed instance");
  assert.equal(attachedOverlays, 1, "a fresh overlay should be attached");
});

/* ── [2] NEGATIVE CONTROL: identity guard ─────────────────────────────── */

// w1 is stale (already cancelled and released) but still reachable — any code
// holding the handle openWizard() returned the first time can still drive it.
// Walk it back to a live page and cancel again so it genuinely REACHES the
// NotStarted branch (a `cancel` straight from NotStarted is an illegal
// transition and returns early, which would make this control unfalsifiable).
w1.transition("open");
assert.equal(w1._state.wizard, "heritage", "stale wizard must be live again for the control to bite");
w1.transition("cancel");
assert.equal(w1._state.wizard, "not-started", "the stale instance must have reached NotStarted");

check("NEGATIVE CONTROL: a stale instance does not evict the live wizard", () => {
  assert.equal(
    mod.__peekWizard(),
    w2,
    "a bare `_wizard = null` (no identity check) nulls the singleton while " +
    "w2 is still on screen — the live wizard becomes unreachable and a " +
    "second openWizard() would stack a duplicate overlay",
  );
});

/* ── [3] closeWizard still works and is idempotent ────────────────────── */

mod.closeWizard();
check("closeWizard tears down and releases", () => {
  assert.equal(mod.__peekWizard(), null);
  assert.equal(attachedOverlays, 0);
});
check("closeWizard is idempotent", () => {
  mod.closeWizard();
  assert.equal(mod.__peekWizard(), null);
});
check("and the wizard opens again afterwards", () => {
  const w3 = mod.openWizard({ client });
  assert.ok(w3);
  assert.notEqual(w3, w2);
  mod.closeWizard();
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
