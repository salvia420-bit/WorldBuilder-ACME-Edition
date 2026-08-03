// tests/character_info_tab_labels.test.mjs — round-9 review, finding R9-9.
//
// `plugins/character-info.js` builds its three tab buttons with explicit
// labels ("Attributes" / "Skills" / "Titles", :1198-1201) but `setTab()`
// re-derived the label from LIVE DOM text on every switch:
//
//     setAcText(btn, btn.textContent || k, { color: ... });   // OLD, :1418
//
// `setAcText` puts an `<ac-text>` element inside the button, and
// `<ac-text>._render()` REPLACES its children with a <canvas>. ac_font.js
// says so itself, in the re-entry guard right above the swap:
//
//     // This is the re-entry guard: when _render() replaces children
//     // with a canvas, textContent becomes "" and the mutation observer
//     // fires; without this check we'd recurse.
//
// So once the AC font has registered and rendered (i.e. in-world, always),
// `btn.textContent` is "" and the `|| k` fallback writes the TAB ID. Clicking
// any tab permanently relabels the strip "attributes / skills / titles" in
// lowercase.
//
// This suite runs setTab under BOTH regimes:
//   (A) pre-registration — setAcText leaves readable text behind. The old
//       code happens to survive here, which is why the bug is invisible in a
//       naive stub and why (B) exists.
//   (B) post-registration — setAcText clears the host's text, modelling the
//       canvas swap quoted above. The old code goes red here.
//
// NEGATIVE CONTROL
//   Regime (A) is itself the control for "the fix didn't just hardcode
//   something": labels must be right in both, and must still fall back to the
//   id for a tab the builder never labelled.
//
// Run from apps/holtburger-web/:
//   node tests/character_info_tab_labels.test.mjs

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

/* ── DOM ──────────────────────────────────────────────────────────────── */

function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null,
    style: {}, dataset: {}, className: "", id: "", type: "",
    _text: "",
    get textContent() {
      if (el.children.length) return el.children.map((c) => c.textContent).join("");
      return el._text;
    },
    set textContent(v) { el._text = String(v ?? ""); el.children.length = 0; },
    innerHTML: "", value: "", disabled: false,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { if (c) { c.parentNode = el; el.children.push(c); } return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    addEventListener(n, fn) { (el._h ??= {})[n] = fn; },
    removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute() {}, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    focus() {},
    ownerDocument: null,
  };
  return el;
}

globalThis.document = {
  createElement: makeEl,
  getElementById: () => null,
  head: makeEl("head"),
  body: makeEl("body"),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  location: { search: "" },
  __pluginClient: { events: { on() {}, off() {} }, player: { stats: null } },
  __sessionHandle: null,
};
globalThis.performance = { now: () => 0 };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ── two setAcText regimes ────────────────────────────────────────────── */

// (A) pre-registration: `<ac-text>` is an inert unknown element, so the
//     string stays readable through the host's textContent.
const SET_AC_TEXT_TEXT_PRESERVING = `
  (el, text) => {
    if (!el) return;
    el.textContent = "";
    const inner = { tagName: "AC-TEXT", textContent: String(text ?? ""), children: [] };
    el.children.push(inner);
  }
`;

// (B) post-registration: <ac-text>._render() replaces its children with a
//     <canvas>, so the host reads back as "". ui/ac_font.js's own re-entry
//     guard documents exactly this.
const SET_AC_TEXT_CANVAS_SWAPPING = `
  (el, text) => {
    if (!el) return;
    globalThis.__lastAcText.set(el, String(text ?? ""));
    el.textContent = "";
    const inner = { tagName: "AC-TEXT", textContent: "", children: [] };
    el.children.push(inner);
  }
`;

globalThis.__lastAcText = new Map();

const src = readFileSync(path.join(APP, "plugins", "character-info.js"), "utf8");

function loadWith(setAcTextSrc) {
  const body = spliceModule(src, {
    label: "plugins/character-info.js",
    provided: [],
    stubs: {
      setAcText: setAcTextSrc,
      loadLayout: "() => Promise.resolve(null)",
      findElementById: "() => null",
      getCachedLayout: "() => null",
      TRAINING: "Object.freeze({ Untrained: 1, Trained: 2, Specialized: 3 })",
      computeNextRaiseCost: "() => null",
      decideTrainAction: "() => null",
    },
  });
  // eslint-disable-next-line no-new-func
  return new Function(body + "\nreturn { view };\n")();
}

function labelsAfterSwitch(setAcTextSrc, { readback }) {
  globalThis.__lastAcText = new Map();
  const mod = loadWith(setAcTextSrc);
  const parent = makeEl("div");
  mod.view.mount(parent, { tab: "skills" });
  // Find the three tab buttons by their dataset.tab marker.
  const btns = [];
  (function walk(n) {
    for (const c of n.children ?? []) {
      if (c.dataset?.tab) btns.push(c);
      walk(c);
    }
  })(parent);
  assert.equal(btns.length, 3, "expected three tab buttons");
  // Click "Titles" — this is what setTab() re-labels every button from.
  const titles = btns.find((b) => b.dataset.tab === "titles");
  titles._h.click();
  return btns.map((b) => readback(b));
}

/* ── regime A ─────────────────────────────────────────────────────────── */

check("(A) pre-font-registration: labels survive a tab switch", () => {
  const got = labelsAfterSwitch(SET_AC_TEXT_TEXT_PRESERVING, {
    readback: (b) => b.textContent,
  });
  assert.deepEqual(got, ["Attributes", "Skills", "Titles"]);
});

/* ── regime B — the one that was broken in-world ──────────────────────── */

check("(B) after the AC font renders, labels are still Title-Case", () => {
  const got = labelsAfterSwitch(SET_AC_TEXT_CANVAS_SWAPPING, {
    readback: (b) => globalThis.__lastAcText.get(b),
  });
  assert.deepEqual(
    got,
    ["Attributes", "Skills", "Titles"],
    "clicking a tab relabelled the strip with the lowercase tab IDS — setTab " +
    "re-read the label from btn.textContent, which <ac-text>._render() empties",
  );
});

/* ── the label stash is what carries it, and it survives repeats ──────── */

check("repeated tab switches never degrade the labels", () => {
  globalThis.__lastAcText = new Map();
  const mod = loadWith(SET_AC_TEXT_CANVAS_SWAPPING);
  const parent = makeEl("div");
  mod.view.mount(parent, { tab: "skills" });
  const btns = [];
  (function walk(n) {
    for (const c of n.children ?? []) {
      if (c.dataset?.tab) btns.push(c);
      walk(c);
    }
  })(parent);
  for (let i = 0; i < 6; i += 1) btns[i % 3]._h.click();
  assert.deepEqual(
    btns.map((b) => globalThis.__lastAcText.get(b)),
    ["Attributes", "Skills", "Titles"],
  );
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
