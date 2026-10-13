// tests/character_creation_attr_balance.test.mjs — maps-chargen-barber-4.
//
// The char-gen Attributes page used to clamp a rise to the sum-based unspent
// credits. Every profession template spends all of them, so after a template
// pick every `+` was dead until the player lowered something by hand, and
// there were no locks. Retail (acclient.c):
//
//   gmCGProfessionPage::SetAttribValue — a rise past
//     CharGenState::GetAbsRemainingCredits(i) lands on current + that, then
//     Set<Attr>(value, balance = 1).
//   CharGenState::GetAbsRemainingCredits(i) — total − Σ_j (locked[j] || j == i
//     ? value[j] : 10).
//   CharGenState::BalanceAttributes(fixed) — while Σ > total, take one point
//     at a time from unlocked attributes > 10 other than `fixed`, in the order
//     Str(1) End(2) Coord(4) Quick(3) Focus(5) Self(6), starting at the STATIC
//     `startAtrb` (`unsigned int startAtrb = 1u;`) and wrapping; the slot after
//     the one that gave the last point becomes the next start.
//   gmCGProfessionPage::SetLock / CharGenState::LockAttribute — per-row lock;
//     CharGenState::ApplyTemplate zeroes bAttribLocked.
//
// CONTRACT
//   [1] the pure helpers (absRemainingCredits / balanceAttributes /
//       setAttribValue) follow the decomp, incl. the drain order, the static
//       start slot persisting across calls, locks, and Σ ≤ total, 10..100;
//   [2] the wizard's Attributes page: `+` is live after a full template and
//       takes from the others; the lock toggle protects a row; a slider drag
//       repaints the other rows; Reset to template / a template change clear
//       the locks; with every other row locked and Σ = total, `+` is off.
//
// Run from apps/holtburger-web/:
//   node tests/character_creation_attr_balance.test.mjs

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

/* ── a DOM small enough to build and click the wizard ─────────────────── */

function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    className: "",
    id: "",
    title: "",
    textContent: "",
    value: "",
    disabled: false,
    listeners,
    get innerHTML() { return ""; },
    set innerHTML(_v) { for (const c of el.children) c.parentNode = null; el.children.length = 0; },
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
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute: (k) => el.attrs[k] ?? null,
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  return el;
}
function fire(el, type) {
  for (const fn of el.listeners[type] || []) fn({ target: el, preventDefault() {} });
}
function walk(el, out = []) {
  out.push(el);
  for (const c of el.children) walk(c, out);
  return out;
}

const docBody = makeEl("body");
globalThis.document = {
  createElement: makeEl,
  createElementNS: () => makeEl("svg"),
  getElementById: () => null,
  head: makeEl("head"),
  body: docBody,
  addEventListener() {},
  removeEventListener() {},
};

// Two templates that spend every one of the 330 credits (fixture spreads,
// not the DAT's; the math only needs Σ == attributeCredits).
const T_SOLDIER = { templateOption: 0, name: "Soldier",
  strength: 70, endurance: 60, coordination: 60, quickness: 60, focus: 40, self: 40, skills: [] };
const T_MAGE = { templateOption: 1, name: "War Mage",
  strength: 30, endurance: 50, coordination: 50, quickness: 40, focus: 80, self: 80, skills: [] };
const CATALOG = {
  heritages: [{
    heritageId: 1,
    name: "Aluvian",
    attributeCredits: 330,
    skillCredits: 50,
    templates: [T_SOLDIER, T_MAGE],
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
const mod = new Function(body + `
return {
  openWizard, closeWizard,
  ATTRIBUTE_BALANCE_ORDER, emptyAttributeLocks, absRemainingCredits,
  balanceAttributes, setAttribValue,
  getAttributeBalanceStart, resetAttributeBalanceStart,
  CHARACTER_GEN_MIN_ATTRIBUTE, CHARACTER_GEN_MAX_ATTRIBUTE,
};
`)();
const {
  ATTRIBUTE_BALANCE_ORDER, emptyAttributeLocks, absRemainingCredits,
  balanceAttributes, setAttribValue,
  getAttributeBalanceStart, resetAttributeBalanceStart,
  CHARACTER_GEN_MIN_ATTRIBUTE: MIN, CHARACTER_GEN_MAX_ATTRIBUTE: MAX,
} = mod;

const KEYS = ["strength", "endurance", "coordination", "quickness", "focus", "self"];
const sum = (a) => KEYS.reduce((s, k) => s + a[k], 0);
const spread = (t) => Object.fromEntries(KEYS.map((k) => [k, t[k]]));
const lockOnly = (...keys) => ({ ...emptyAttributeLocks(), ...Object.fromEntries(keys.map((k) => [k, true])) });
/** The key whose value went down from `a` to `b` (exactly one expected). */
function drainedKey(a, b) {
  const down = KEYS.filter((k) => b[k] < a[k]);
  assert.equal(down.length, 1, `expected one drained attribute, got ${JSON.stringify(down)}`);
  return down[0];
}

/* ── [1] pure helpers ─────────────────────────────────────────────────── */

console.log("[1] absRemainingCredits / balanceAttributes / setAttribValue");

check("drain order is the decomp's Str, End, Coord, Quick, Focus, Self", () => {
  assert.deepEqual([...ATTRIBUTE_BALANCE_ORDER],
    ["strength", "endurance", "coordination", "quickness", "focus", "self"]);
  assert.ok(Object.isFrozen(ATTRIBUTE_BALANCE_ORDER));
});

check("absRemainingCredits: unlocked others count at their floor of 10", () => {
  const a = spread(T_SOLDIER);
  // 330 − 70 (strength itself) − 5 × 10
  assert.equal(absRemainingCredits(a, emptyAttributeLocks(), "strength", 330), 210);
  // a locked other counts at its value: 330 − 70 − 60 (endurance) − 4 × 10
  assert.equal(absRemainingCredits(a, lockOnly("endurance"), "strength", 330), 160);
  // the attribute's own lock changes nothing (it already counts at its value)
  assert.equal(absRemainingCredits(a, lockOnly("strength"), "strength", 330), 210);
});

check("absRemainingCredits: with every other attribute locked it is total − Σ", () => {
  const a = { strength: 50, endurance: 60, coordination: 45, quickness: 55, focus: 40, self: 30 };
  const others = lockOnly("endurance", "coordination", "quickness", "focus", "self");
  assert.equal(absRemainingCredits(a, others, "strength", 330), 330 - sum(a));
  assert.equal(absRemainingCredits(spread(T_SOLDIER), others, "strength", 330), 0);
});

check("after a full template, + on Strength raises it and drains End, Coord, Quick, Focus, Self, End …", () => {
  resetAttributeBalanceStart();
  let a = spread(T_SOLDIER);
  const order = [];
  for (let n = 0; n < 7; n++) {
    const b = setAttribValue(a, emptyAttributeLocks(), "strength", a.strength + 1, 330);
    assert.equal(b.strength, a.strength + 1, "the + must land");
    order.push(drainedKey(a, b));
    assert.equal(sum(b), 330);
    a = b;
  }
  // Strength is the moved attribute (_fixedAtrb) so it is skipped on the wrap.
  assert.deepEqual(order,
    ["endurance", "coordination", "quickness", "focus", "self", "endurance", "coordination"]);
  assert.equal(a.strength, 77);
});

check("startAtrb is static: it persists across calls and moves to the slot after the last drain", () => {
  resetAttributeBalanceStart();
  assert.equal(getAttributeBalanceStart(), "strength", "retail `startAtrb = 1u` at client start");
  let a = setAttribValue(spread(T_SOLDIER), emptyAttributeLocks(), "strength", 71, 330);
  assert.equal(getAttributeBalanceStart(), "coordination", "End gave the last point → next start Coord");
  // A move with no overspend (a lowering) leaves the static alone.
  a = setAttribValue(a, emptyAttributeLocks(), "focus", a.focus - 2, 330);
  assert.equal(getAttributeBalanceStart(), "coordination");
  // The next overspend resumes at Coordination, not Strength — even when it is
  // a different attribute that moved.
  const b = setAttribValue(a, emptyAttributeLocks(), "endurance", a.endurance + 3, 330);
  assert.equal(drainedKey(a, b), "coordination", "2 unspent credits absorb 2 of the 3, Coord gives 1");
  assert.equal(getAttributeBalanceStart(), "quickness");
});

check("Focus giving the last point moves the start to Self; Self wraps to Strength", () => {
  resetAttributeBalanceStart("focus");
  const a = spread(T_SOLDIER);
  const b = setAttribValue(a, emptyAttributeLocks(), "strength", 71, 330);
  assert.equal(drainedKey(a, b), "focus");
  assert.equal(getAttributeBalanceStart(), "self", "the decomp's `break` → startAtrb = 6");
  const c = setAttribValue(b, emptyAttributeLocks(), "endurance", b.endurance + 1, 330);
  assert.equal(drainedKey(b, c), "self");
  assert.equal(getAttributeBalanceStart(), "strength", "Self → startAtrb = 1");
  const d = setAttribValue(c, emptyAttributeLocks(), "endurance", c.endurance + 1, 330);
  assert.equal(drainedKey(c, d), "strength", "Strength is drainable when another attribute moved");
});

check("a locked attribute is never lowered", () => {
  resetAttributeBalanceStart();
  const locks = lockOnly("endurance", "coordination");
  const a = spread(T_SOLDIER);
  const b = setAttribValue(a, locks, "strength", 95, 330);
  assert.equal(b.strength, 95);
  assert.equal(b.endurance, a.endurance);
  assert.equal(b.coordination, a.coordination);
  assert.equal(sum(b), 330);
  // 25 points came out of Quick / Focus / Self, round-robin from Strength's slot
  assert.equal((a.quickness - b.quickness) + (a.focus - b.focus) + (a.self - b.self), 25);
  assert.ok(Math.abs((a.quickness - b.quickness) - (a.focus - b.focus)) <= 1, "spread one point at a time");
});

check("a rise past GetAbsRemainingCredits lands on current + that", () => {
  resetAttributeBalanceStart();
  const a = { strength: 50, endurance: 100, coordination: 100, quickness: 50, focus: 10, self: 20 };
  const locks = lockOnly("endurance", "coordination", "quickness");
  assert.equal(absRemainingCredits(a, locks, "strength", 330), 10);
  const b = setAttribValue(a, locks, "strength", 100, 330);
  assert.equal(b.strength, 60, "clamped to 50 + 10");
  assert.equal(b.self, 10, "Self is the only unlocked attribute above 10");
  assert.equal(b.focus, 10);
  assert.deepEqual([b.endurance, b.coordination, b.quickness], [100, 100, 50]);
});

check("with every other attribute locked and Σ = total, a rise is refused", () => {
  resetAttributeBalanceStart();
  const a = spread(T_SOLDIER);
  const locks = lockOnly("endurance", "coordination", "quickness", "focus", "self");
  const b = setAttribValue(a, locks, "strength", 80, 330);
  assert.deepEqual(b, a);
  assert.equal(getAttributeBalanceStart(), "strength", "nothing drained, static untouched");
});

check("unspent credits are used first; only the overspend is drained", () => {
  resetAttributeBalanceStart();
  const a = { ...spread(T_SOLDIER), focus: 30 }; // Σ = 320, 10 unspent
  const b = setAttribValue(a, emptyAttributeLocks(), "strength", 75, 330);
  assert.deepEqual(b, { ...a, strength: 75 }, "5 of the 10 unspent, nothing drained");
  assert.equal(getAttributeBalanceStart(), "strength");
  const c = setAttribValue(b, emptyAttributeLocks(), "strength", 85, 330);
  assert.equal(sum(c), 330);
  assert.equal(c.strength, 85);
  assert.equal(sum(b) - b.strength - (sum(c) - c.strength), 5, "5 unspent + 5 drained");
});

check("lowering frees credits and drains nothing", () => {
  resetAttributeBalanceStart();
  const a = spread(T_SOLDIER);
  const b = setAttribValue(a, emptyAttributeLocks(), "strength", 60, 330);
  assert.deepEqual(b, { ...a, strength: 60 });
  assert.equal(sum(b), 320);
});

check("values are held to 10..100 and the input object is not touched", () => {
  resetAttributeBalanceStart();
  const a = spread(T_SOLDIER);
  const frozen = JSON.stringify(a);
  assert.equal(setAttribValue(a, emptyAttributeLocks(), "focus", 3, 330).focus, MIN);
  assert.equal(setAttribValue(a, emptyAttributeLocks(), "strength", 250, 330).strength, MAX);
  assert.equal(setAttribValue(a, emptyAttributeLocks(), "strength", NaN, 330).strength, a.strength);
  assert.equal(JSON.stringify(a), frozen);
});

check("balanceAttributes stops on an overspend nothing can absorb (no hang)", () => {
  resetAttributeBalanceStart();
  const a = { strength: 100, endurance: 100, coordination: 100, quickness: 100, focus: 10, self: 10 };
  const b = balanceAttributes(a, lockOnly("endurance", "coordination", "quickness"), "strength", 330);
  assert.deepEqual(b, a, "nothing unlocked above 10 — returns unchanged");
  assert.equal(getAttributeBalanceStart(), "strength");
});

check("invariants over 3000 random moves: Σ ≤ total, 10..100, locks hold", () => {
  resetAttributeBalanceStart();
  let seed = 0x5eed1234;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
  let a = spread(T_SOLDIER);
  let locks = emptyAttributeLocks();
  for (let step = 0; step < 3000; step++) {
    const op = rnd(10);
    const key = KEYS[rnd(6)];
    if (op === 0) { locks = { ...locks, [key]: !locks[key] }; continue; }
    const target = op < 4 ? a[key] + 1 : op < 6 ? a[key] - 1 : MIN + rnd(MAX - MIN + 1);
    const b = setAttribValue(a, locks, key, target, 330);
    assert.ok(sum(b) <= 330, `step ${step}: Σ ${sum(b)} > 330`);
    for (const k of KEYS) {
      assert.ok(b[k] >= MIN && b[k] <= MAX, `step ${step}: ${k} = ${b[k]}`);
      if (k !== key && locks[k]) assert.equal(b[k], a[k], `step ${step}: locked ${k} moved`);
      if (k !== key && b[k] > a[k]) assert.fail(`step ${step}: ${k} rose without being moved`);
    }
    a = b;
  }
});

/* ── [2] the wizard's Attributes page ─────────────────────────────────── */

console.log("[2] wizard Attributes page");

function attrRows(overlay) {
  const rows = {};
  for (const row of walk(overlay).filter((e) => e.className === "hb-cc-attr-row")) {
    const lock = row.children.find((c) => /\block-btn\b/.test(c.className));
    const dec = row.children.find((c) => /\bdec\b/.test(c.className));
    const inc = row.children.find((c) => /\binc\b/.test(c.className));
    const slider = row.children.find((c) => c.type === "range");
    const val = row.children.find((c) => c.className === "value");
    rows[lock.dataset.attr] = { row, lock, dec, inc, slider, val };
  }
  return rows;
}
function footerButton(overlay, text) {
  return walk(overlay).find((e) => e.tagName === "BUTTON" && e.textContent === text);
}

mod.closeWizard();
const w = mod.openWizard({ client });
assert.ok(w, "wizard must open with the fixture catalog");
const overlay = docBody.children[docBody.children.length - 1];
w.transition("next");
assert.equal(w._state.wizard, "attributes");

check("the default template spends all 330 credits and nothing is locked", () => {
  assert.equal(sum(w._state.attributes), 330);
  assert.deepEqual(w._state.attributeLocks, emptyAttributeLocks());
  assert.equal(Object.keys(attrRows(overlay)).length, 6);
});

check("+ is live after a full template and takes the point from the next unlocked row", () => {
  resetAttributeBalanceStart();
  const r = attrRows(overlay);
  assert.equal(r.strength.inc.disabled, false, "used to be disabled once every credit was spent");
  fire(r.strength.inc, "click");
  assert.equal(w._state.attributes.strength, 71);
  assert.equal(w._state.attributes.endurance, 59);
  assert.equal(sum(w._state.attributes), 330);
  assert.equal(attrRows(overlay).strength.val.textContent, "71");
});

check("the lock toggle marks the row and keeps it from being drained", () => {
  // the static now points at Coordination (Endurance gave the last point)
  assert.equal(getAttributeBalanceStart(), "coordination");
  fire(attrRows(overlay).coordination.lock, "click");
  assert.equal(w._state.attributeLocks.coordination, true);
  const r = attrRows(overlay);
  assert.match(r.coordination.lock.className, /\blocked\b/);
  assert.equal(r.coordination.lock.attrs["aria-pressed"], "true");
  const before = { ...w._state.attributes };
  fire(r.strength.inc, "click");
  assert.equal(w._state.attributes.coordination, before.coordination, "locked Coordination untouched");
  assert.equal(w._state.attributes.quickness, before.quickness - 1, "skipped to Quickness");
});

check("− lowers only its own row", () => {
  const before = { ...w._state.attributes };
  fire(attrRows(overlay).self.dec, "click");
  assert.deepEqual(w._state.attributes, { ...before, self: before.self - 1 });
});

check("a slider drag rebalances and repaints the other rows in place", () => {
  const r = attrRows(overlay);
  r.strength.slider.value = "95";
  fire(r.strength.slider, "input");
  const a = w._state.attributes;
  assert.equal(a.strength, 95);
  assert.ok(sum(a) <= 330);
  for (const k of KEYS) {
    assert.equal(r[k].slider.value, String(a[k]), `${k} slider repainted`);
    assert.equal(r[k].val.textContent, String(a[k]), `${k} value repainted`);
  }
  fire(r.strength.slider, "change"); // full re-render on release
  assert.equal(attrRows(overlay).strength.val.textContent, "95");
});

check("with every other row locked and Σ = total, + is disabled", () => {
  // spend the 1 credit − freed above, then lock the other five
  const r0 = attrRows(overlay);
  if (sum(w._state.attributes) < 330) {
    r0.focus.slider.value = String(w._state.attributes.focus + (330 - sum(w._state.attributes)));
    fire(r0.focus.slider, "input");
    fire(r0.focus.slider, "change");
  }
  assert.equal(sum(w._state.attributes), 330);
  for (const k of ["endurance", "quickness", "focus", "self"]) {
    fire(attrRows(overlay)[k].lock, "click");
  }
  assert.deepEqual(w._state.attributeLocks, lockOnly("endurance", "coordination", "quickness", "focus", "self"));
  const r = attrRows(overlay);
  assert.equal(r.strength.inc.disabled, true);
  assert.equal(r.endurance.inc.disabled, false, "a locked row can still take from the unlocked Strength");
});

check("Reset to template restores the spread and clears every lock", () => {
  fire(footerButton(overlay, "Reset to template"), "click");
  assert.deepEqual(w._state.attributes, spread(T_SOLDIER));
  assert.deepEqual(w._state.attributeLocks, emptyAttributeLocks());
});

check("a template change on the Heritage page clears the locks (CharGenState::ApplyTemplate)", () => {
  fire(attrRows(overlay).self.lock, "click");
  assert.equal(w._state.attributeLocks.self, true);
  w.transition("back");
  assert.equal(w._state.wizard, "heritage");
  const tmplSel = walk(overlay).find((e) => e.tagName === "SELECT"
    && e.children.some((o) => o.textContent === "War Mage"));
  assert.ok(tmplSel, "template select rendered");
  tmplSel.value = "1";
  fire(tmplSel, "change");
  assert.deepEqual(w._state.attributes, spread(T_MAGE));
  assert.deepEqual(w._state.attributeLocks, emptyAttributeLocks());
});

mod.closeWizard();

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
