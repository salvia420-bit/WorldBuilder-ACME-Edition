// tests/character_creation_colors.test.mjs — maps-chargen-barber-3 (2026-10-13).
//
// Retail gmCGAppearancePage (acclient.c) has nine parts — hair, eyes, nose,
// mouth, skin, headgear, shirt, trousers, footwear — each with a colour
// wheel of spots (SetSelection :186939) and, all but the eyes, a shade
// scroll (SetShade :185502). The clothing spots are the GEAR's own list
// (CharGenState::StoreColorInformation :495905) and the colour index is an
// index into it; Set*Style keeps the colour but clamps it into the new
// gear's list (:496750-496960); Randomize* rolls inside it (:497279-497381).
// holtburger's wizard rolled hair / eye / skin / clothing colours and
// shades at random only, and had no shirt / trousers / footwear style rows.
//
// CONTRACT
//   [1] pure helpers: gearColorCount / clampGearColors / rerollGearColors /
//       spotCss / clampShade; randomizeAppearance rolls each clothing colour
//       inside its gear's count when `colorCountFor` knows it; every colour
//       row's keys are payload keys (CharacterCreateAppearanceJs).
//   [2] the Heritage page shows Hair colour / Eye colour / Skin / Hat colour
//       rows and Shirt / Trousers / Footwear style + colour rows; spots take
//       the wheel's colours once `chargenColorWheel` resolves, and the first
//       random clothing colours are fitted to the gear lists
//       (`chargenGearColors`).
//   [3] clicking spots / moving shade scrolls sets hairColor, eyeColor,
//       shirtColor, skinHue, hairHue, pantsHue in state; a shirt style
//       change clamps shirtColor into the new shirt's list.
//   [4] the submitted payload carries the picks unchanged.
//   [5] hat: "none" drops the hat colour row; a hat put on again rolls its
//       colour inside the hat's list.
//
// NEGATIVE CONTROL
//   [6] a stale pkg/ (no chargenColorWheel / chargenGearColors) shows no
//       colour rows, keeps the style rows, and does not throw.
//
// Run from apps/holtburger-web/:  node tests/character_creation_colors.test.mjs

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
  catch (e) { failed += 1; console.log(`  [FAIL] ${name} — ${e.stack || e.message}`); }
}

/* ── a DOM small enough for the wizard overlay ─────────────────────────── */

function makeEl(tag) {
  const listeners = {};
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
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
    dispatch(type) { for (const fn of listeners[type] || []) fn({ preventDefault() {}, stopPropagation() {} }); },
    click() { el.dispatch("click"); },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  // className mirrors into classList (the spots read both).
  let cls = "";
  Object.defineProperty(el, "className", {
    get: () => [cls, ...classes].filter(Boolean).join(" "),
    set: (v) => { cls = String(v); classes.clear(); },
  });
  // render() and the spot rows clear with `innerHTML = ""`.
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
globalThis.document = {
  createElement: makeEl,
  createElementNS: () => makeEl("svg"),
  getElementById: () => null,
  head: makeEl("head"),
  body: docBody,
  addEventListener() {},
  removeEventListener() {},
};

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i += 1) await tick(); }

/* ── load the plugin (its two static imports stubbed) ─────────────────── */

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
return { openWizard, closeWizard, randomizeAppearance, buildCharGenPayload,
  CHARGEN_COLOR_ROWS, chargenColorRow, gearColorCount, clampGearColors,
  rerollGearColors, spotCss, clampShade };
`)();

/* ── [1] pure helpers ─────────────────────────────────────────────────── */

console.log("[1] pure helpers");

// Shirt 0 offers one colour, shirt 1 two; the trousers' table did not
// load; the hat and the footwear offer two.
const GEAR = {
  heritage: 1, gender: 1,
  headgear: [{ templateIds: [9, 4], palSetIds: [0x0F000019, 0x0F000014] }],
  shirt: [
    { templateIds: [4], palSetIds: [0x0F000004] },
    { templateIds: [12, 6], palSetIds: [0x0F00000C, 0x0F000006] },
  ],
  trousers: [null],
  footwear: [{ templateIds: [4, 9], palSetIds: [0x0F000004, 0x0F000009] }],
};

await check("gearColorCount reads a style's list size, null when unknown", () => {
  assert.equal(mod.gearColorCount(GEAR, "shirt", 0), 1);
  assert.equal(mod.gearColorCount(GEAR, "shirt", 1), 2);
  assert.equal(mod.gearColorCount(GEAR, "shirt", 2), null, "no such style");
  assert.equal(mod.gearColorCount(GEAR, "trousers", 0), null, "table not loaded");
  assert.equal(mod.gearColorCount(null, "shirt", 0), null);
});

await check("clampGearColors: Set*Style keeps the colour, drops it to the list's last entry", () => {
  const a = { headgearStyle: 0, headgearColor: 5, shirtStyle: 1, shirtColor: 1,
    pantsStyle: 0, pantsColor: 3, footwearStyle: 0, footwearColor: 7 };
  mod.clampGearColors(a, GEAR);
  assert.equal(a.headgearColor, 1);
  assert.equal(a.shirtColor, 1, "inside the list: kept");
  assert.equal(a.pantsColor, 3, "unknown list: left alone");
  assert.equal(a.footwearColor, 1);
  a.shirtStyle = 0;
  mod.clampGearColors(a, GEAR);
  assert.equal(a.shirtColor, 0);
  const none = { headgearStyle: 0xFFFFFFFF, headgearColor: 0, shirtStyle: 0, shirtColor: 0 };
  mod.clampGearColors(none, GEAR);
  assert.equal(none.headgearColor, 0, "no hat: untouched");
  const empty = { shirtStyle: 0, shirtColor: 3 };
  mod.clampGearColors(empty, { shirt: [{ templateIds: [], palSetIds: [] }] });
  assert.equal(empty.shirtColor, 0, "an empty list leaves 0");
});

await check("rerollGearColors rolls an out-of-list colour inside the list", () => {
  const a = { headgearStyle: 0, headgearColor: 1, shirtStyle: 1, shirtColor: 9,
    pantsStyle: 0, pantsColor: 9, footwearStyle: 0, footwearColor: 3 };
  mod.rerollGearColors(a, GEAR, () => 0.99);
  assert.equal(a.headgearColor, 1, "inside the list: kept");
  assert.equal(a.shirtColor, 1);
  assert.equal(a.pantsColor, 9, "unknown list: left alone");
  assert.equal(a.footwearColor, 1);
});

await check("spotCss / clampShade", () => {
  assert.equal(mod.spotCss([16, 32, 48]), "rgb(16, 32, 48)");
  assert.equal(mod.spotCss(null), null);
  assert.equal(mod.spotCss([300, -5, 7]), "rgb(255, 0, 7)");
  assert.equal(mod.clampShade("0.25"), 0.25);
  assert.equal(mod.clampShade(3), 1);
  assert.equal(mod.clampShade(-1), 0);
  assert.equal(mod.clampShade("x"), 0);
});

await check("randomizeAppearance rolls clothing colours inside each gear's count", () => {
  const gender = { appearance: {
    eyeStripCount: 2, noseStripCount: 2, mouthStripCount: 2, hairColorCount: 3,
    eyeColorCount: 3, hairStyleCount: 2, headgearCount: 1, shirtCount: 2,
    pantsCount: 1, footwearCount: 1, clothingColorCount: 16,
  } };
  const asked = [];
  for (let i = 0; i < 200; i += 1) {
    const a = mod.randomizeAppearance(gender, (gear, style) => {
      asked.push(gear);
      return mod.gearColorCount(GEAR, gear, style);
    });
    assert.ok(a.headgearColor < 2, `hat ${a.headgearColor}`);
    assert.ok(a.shirtColor < (a.shirtStyle === 0 ? 1 : 2), `shirt ${a.shirtStyle}/${a.shirtColor}`);
    assert.ok(a.pantsColor < 16, "unknown list: the gender range");
    assert.ok(a.footwearColor < 2);
  }
  assert.ok(["headgear", "shirt", "trousers", "footwear"].every((g) => asked.includes(g)));
  // Without the callback: the old gender range.
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) seen.add(mod.randomizeAppearance(gender).shirtColor);
  assert.ok(Math.max(...seen) > 2, "gender-list range without the gear lists");
});

await check("every colour row names payload keys (CharacterCreateAppearanceJs)", () => {
  const payloadKeys = new Set(Object.keys(mod.randomizeAppearance({ appearance: {
    eyeStripCount: 1, noseStripCount: 1, mouthStripCount: 1, hairColorCount: 1,
    eyeColorCount: 1, hairStyleCount: 1, headgearCount: 1, shirtCount: 1,
    pantsCount: 1, footwearCount: 1, clothingColorCount: 1,
  } })));
  assert.deepEqual(mod.CHARGEN_COLOR_ROWS.map((r) => r.part),
    ["hair", "eyes", "skin", "headgear", "shirt", "trousers", "footwear"]);
  for (const row of mod.CHARGEN_COLOR_ROWS) {
    for (const k of [row.colorKey, row.shadeKey, row.styleKey]) {
      if (k) assert.ok(payloadKeys.has(k), `${row.part}: ${k}`);
    }
  }
  assert.equal(mod.chargenColorRow("eyes").shadeKey, null, "the eyes have no shade scroll");
});

/* ── the wizard with a session handle ─────────────────────────────────── */

const CATALOG = {
  expectedSkillSlots: 1,
  heritages: [{
    heritageId: 1,
    name: "Aluvian",
    attributeCredits: 330,
    skillCredits: 50,
    primaryStartAreaIds: [0],
    secondaryStartAreaIds: [],
    templates: [{
      templateOption: 0, name: "Soldier",
      strength: 55, endurance: 55, coordination: 55,
      quickness: 55, focus: 55, self: 55,
      normalSkills: [], primarySkills: [],
    }],
    genders: [{
      genderId: 1, name: "Male",
      appearance: {
        eyeStripCount: 1, noseStripCount: 1, mouthStripCount: 1,
        hairColorCount: 2, eyeColorCount: 2, hairStyleCount: 1,
        headgearCount: 1, clothingColorCount: 5,
        shirtCount: 2, pantsCount: 1, footwearCount: 1,
      },
    }],
  }],
  starterAreas: [{ startAreaId: 0, name: "Holtburg" }],
  skills: [],
};

const STRIPS = {
  heritageId: 1, genderId: 1,
  hairStyles: [{ index: 0, iconImage: 0x06000001, bald: false }],
  eyeStrips: [{ index: 0, iconImage: 0x06000002, iconImageBald: 0x06000003 }],
  noseStrips: [{ index: 0, iconImage: 0x06000004 }],
  mouthStrips: [{ index: 0, iconImage: 0x06000005 }],
  headgearStyles: [{ index: 0, name: "Cap" }],
  shirts: [{ index: 0, name: "Shirt" }, { index: 1, name: "Tunic" }],
  pants: [{ index: 0, name: "Pants" }],
  footwear: [{ index: 0, name: "Shoes" }],
  hairColors: [0x0F000201, 0x0F000202], eyeColors: [0x04000301, 0x04000302],
  clothingColors: [9, 6, 4, 1, 12],
};

// Spot colours per part: part index × 16 + spot, so a test can tell them apart.
const PART_BASE = { hair: 1, eyes: 2, skin: 3, headgear: 4, shirt: 5, trousers: 6, footwear: 7 };
const wheelCalls = [];
const handle = {
  chargenGearColors: async (h, g) => JSON.stringify({ ...GEAR, heritage: h, gender: g }),
  chargenColorWheel: async (h, g, part, style) => {
    wheelCalls.push([part, style]);
    let count;
    if (part === "hair" || part === "eyes") count = 2;
    else if (part === "skin") count = 1;
    else count = mod.gearColorCount(GEAR, part, style) ?? 0;
    const spots = Array.from({ length: count }, (_, i) => [PART_BASE[part] * 16 + i, 0, 0]);
    return JSON.stringify({ part, style, shade: part !== "eyes", count, spots,
      templateIds: count && GEAR[part] ? GEAR[part][style]?.templateIds ?? null : null });
  },
};

const submitted = [];
const client = {
  characters: {
    getCatalog: () => CATALOG,
    appearanceStrips: () => STRIPS,
    createCharacter(build) { submitted.push(build); },
  },
  events: { on() {}, off() {} },
};
window.__pluginClient = client;

function overlay() { return docBody.children[docBody.children.length - 1]; }
function colorRow(part) {
  return walk(overlay()).find((e) => e.dataset?.colorRow === part) ?? null;
}
function spotsOf(part) {
  return walk(colorRow(part)).filter((e) => e.dataset?.spot != null);
}
function shadeOf(part) {
  return walk(colorRow(part)).find((e) => e.dataset?.shadeKey) ?? null;
}
function styleRow(label) {
  return walk(overlay()).find((e) => e.className === "hb-cc-swatch-row"
    && e.children[0]?.textContent === `${label}:`) ?? null;
}
function styleSwatch(label, index) {
  return walk(styleRow(label)).filter((e) => e.tagName === "BUTTON" && /hb-cc-swatch/.test(e.className)
    && !/none/.test(e.className))[index];
}

console.log("[2] the Heritage page's colour rows");

window.__sessionHandle = handle;
const realRandom = Math.random;
Math.random = () => 0.99; // the first roll: every index at the top of its range
let w;
try {
  w = mod.openWizard({ client });
} finally {
  Math.random = realRandom;
}

await check("the wizard opens on Heritage with every colour row and the gear style rows", () => {
  assert.ok(w, "opens with the fixture catalog");
  assert.equal(w._state.wizard, "heritage");
  for (const part of ["hair", "eyes", "skin", "headgear", "shirt", "trousers", "footwear"]) {
    assert.ok(colorRow(part), `${part} colour row`);
  }
  for (const label of ["Shirt", "Trousers", "Footwear", "Hat"]) assert.ok(styleRow(label), `${label} style row`);
  assert.equal(shadeOf("eyes"), null, "no shade scroll for the eyes");
  assert.equal(shadeOf("hair").dataset.shadeKey, "hairHue");
  assert.equal(shadeOf("skin").dataset.shadeKey, "skinHue");
});

await check("first roll is over the gender list (lists not loaded yet)", () => {
  assert.equal(w._state.appearance.shirtStyle, 1);
  assert.equal(w._state.appearance.shirtColor, 4, "floor(0.99 × 5)");
});

await settle();

await check("the gear lists arrive: out-of-list colours are rolled inside them", () => {
  const a = w._state.appearance;
  assert.ok(a.shirtColor < 2, `shirt colour ${a.shirtColor}`);
  assert.ok(a.footwearColor < 2, `footwear colour ${a.footwearColor}`);
  assert.ok(a.headgearColor < 2, `hat colour ${a.headgearColor}`);
  assert.equal(a.pantsColor, 4, "the trousers' table did not load: left alone");
});

await check("spots take the wheel's colours; the gear rows show the gear's own count", () => {
  assert.deepEqual(spotsOf("hair").map((b) => b.style.background), ["rgb(16, 0, 0)", "rgb(17, 0, 0)"]);
  assert.deepEqual(spotsOf("eyes").map((b) => b.style.background), ["rgb(32, 0, 0)", "rgb(33, 0, 0)"]);
  assert.deepEqual(spotsOf("skin").map((b) => b.style.background), ["rgb(48, 0, 0)"]);
  assert.equal(spotsOf("shirt").length, 2, "Tunic offers two colours");
  assert.equal(spotsOf("shirt")[1].style.background, "rgb(81, 0, 0)");
  assert.equal(spotsOf("headgear").length, 2);
  assert.equal(spotsOf("footwear").length, 2);
  assert.equal(spotsOf("trousers").length, 0, "the trousers' table did not load: no spots");
  assert.equal(walk(colorRow("trousers")).find((e) => e.className === "pending")?.textContent, "—",
    "…and a dash mark");
  assert.ok(wheelCalls.some(([p, s]) => p === "shirt" && s === 1), "the shirt wheel is the chosen style's");
});

console.log("[3] picking colours and shades");

await check("spot clicks set hairColor / eyeColor / shirtColor (SetColor)", () => {
  spotsOf("hair")[1].click();
  spotsOf("eyes")[0].click();
  spotsOf("shirt")[0].click();
  const a = w._state.appearance;
  assert.equal(a.hairColor, 1);
  assert.equal(a.eyeColor, 0);
  assert.equal(a.shirtColor, 0);
  assert.ok(spotsOf("hair")[1].classList.contains("selected"), "the picked spot is marked");
  assert.ok(!spotsOf("hair")[0].classList.contains("selected"));
});

await check("shade scrolls set the hues (SetShade, 0..1)", () => {
  const set = (part, v) => { const s = shadeOf(part); s.value = String(v); s.dispatch("input"); };
  set("hair", 0.25);
  set("skin", 0.75);
  set("trousers", 2);
  set("shirt", 0.5);
  const a = w._state.appearance;
  assert.equal(a.hairHue, 0.25);
  assert.equal(a.skinHue, 0.75);
  assert.equal(a.pantsHue, 1, "held to [0, 1]");
  assert.equal(a.shirtHue, 0.5);
});

await check("a shirt style change keeps the colour but clamps it into the new list", async () => {
  spotsOf("shirt")[1].click(); // Tunic, colour 1
  assert.equal(w._state.appearance.shirtColor, 1);
  styleSwatch("Shirt", 0).click(); // Shirt offers one colour
  assert.equal(w._state.appearance.shirtStyle, 0);
  assert.equal(w._state.appearance.shirtColor, 0, "1 → the last entry, 0");
  await settle();
  assert.equal(spotsOf("shirt").length, 1);
  assert.equal(spotsOf("shirt")[0].style.background, "rgb(80, 0, 0)");
  styleSwatch("Shirt", 1).click();
  assert.equal(w._state.appearance.shirtColor, 0, "kept when it fits");
});

console.log("[4] the payload");

await check("the submitted payload carries the picks", () => {
  const a = w._state.appearance;
  w._state.name = "Bestie";
  w._state.wizard = "summary";
  w.transition("submit");
  assert.equal(submitted.length, 1, "createCharacter called once");
  const p = submitted[0].appearance;
  assert.equal(p, a, "the wizard's appearance object goes out as is");
  assert.equal(p.hairColor, 1);
  assert.equal(p.eyeColor, 0);
  assert.equal(p.hairHue, 0.25);
  assert.equal(p.skinHue, 0.75);
  assert.equal(p.shirtStyle, 1);
  assert.equal(p.shirtColor, 0);
  assert.equal(p.shirtHue, 0.5);
  assert.equal(p.pantsHue, 1);
  // buildCharGenPayload passes the appearance through.
  const built = mod.buildCharGenPayload({
    heritage: 1, gender: 1, templateOption: 0,
    attributes: { strength: 55, endurance: 55, coordination: 55, quickness: 55, focus: 55, self: 55 },
    appearance: p, skillStates: {}, name: "Bestie", startArea: 0, expectedSkillSlots: 1,
  });
  assert.deepEqual(built.appearance, p);
});

console.log("[5] the hat");

await check("no hat drops the hat colour row; a hat put on again rolls inside its list", async () => {
  mod.closeWizard();
  w = mod.openWizard({ client });
  await settle();
  const none = walk(styleRow("Hat")).find((e) => /none/.test(e.className));
  none.click();
  assert.equal(w._state.appearance.headgearStyle, 0xFFFFFFFF);
  assert.equal(w._state.appearance.headgearColor, 0);
  assert.equal(colorRow("headgear"), null, "no hat, no hat colour row");
  Math.random = () => 0.99;
  try {
    styleSwatch("Hat", 0).click();
  } finally {
    Math.random = realRandom;
  }
  assert.equal(w._state.appearance.headgearStyle, 0);
  assert.equal(w._state.appearance.headgearColor, 1, "floor(0.99 × 2), the hat's own list");
  assert.ok(colorRow("headgear"), "the row is back");
  // Changing hats (here: the same hat again) keeps the picked colour.
  spotsOf("headgear")[0].click();
  styleSwatch("Hat", 0).click();
  assert.equal(w._state.appearance.headgearColor, 0, "not re-rolled");
});

console.log("[6] negative control: a stale pkg/");

await check("no chargenColorWheel / chargenGearColors: no colour rows, the style rows stay", async () => {
  mod.closeWizard();
  window.__sessionHandle = {};
  w = mod.openWizard({ client });
  await settle();
  for (const part of ["hair", "eyes", "skin", "headgear", "shirt", "trousers", "footwear"]) {
    assert.equal(colorRow(part), null, `${part} colour row`);
  }
  for (const label of ["Shirt", "Trousers", "Footwear", "Hat"]) assert.ok(styleRow(label), `${label} style row`);
  styleSwatch("Shirt", 0).click();
  assert.equal(w._state.appearance.shirtStyle, 0);
  window.__sessionHandle = null;
  mod.closeWizard();
  w = mod.openWizard({ client });
  assert.equal(colorRow("hair"), null, "no handle at all");
  mod.closeWizard();
});

console.log(`\ncharacter_creation_colors: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
