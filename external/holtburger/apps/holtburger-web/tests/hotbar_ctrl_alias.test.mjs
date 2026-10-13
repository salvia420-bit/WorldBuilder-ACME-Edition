// tests/hotbar_ctrl_alias.test.mjs — input-options-3 (2026-10-13).
//
// Retail gmDefaultMap (portal 0x14000000, quickslot input map 0x1000000C)
// binds Quickslot 1-9 to DigitN AND Ctrl+DigitN, and Quickslot 10-18 to
// Alt+1..9. The magic map 0x10000005 (magic mode only) takes the BARE digits
// for Spell Slot 1-9 and nothing else, so in magic stance Ctrl+N still fires
// hotbar row 1 and Alt+N row 2. Before this change the client had no Ctrl
// alias (row 1 unreachable from the keyboard in magic stance) and shipped
// row 2 unbound.
//
// Mounts the REAL plugins/hotbar.js against the fake DOM from
// tests/hud_focus_hotbar.test.mjs, with the REAL InputFunnel on the document
// and stand-ins for combat-bar's UseSpellSlot_1..9 actions (same `when`
// scope and source as plugins/combat-bar.js installSpellBarHotkeys).
//
// Run from apps/holtburger-web/:  node tests/hotbar_ctrl_alias.test.mjs

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// ─── fake DOM (after tests/hud_focus_hotbar.test.mjs) ─────────────────
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) if (x) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  toString() { return [...this.set].join(" "); }
}
class FakeStyle {
  setProperty(k, v) { this[k] = String(v); }
  getPropertyValue(k) { return this[k] ?? ""; }
  removeProperty(k) { delete this[k]; }
}
let docRef = null;
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.dataset = {};
    this.attrs = {};
    this.listeners = [];
    this.classList = new FakeClassList();
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = -1;
    this.id = "";
    this.ownerDocument = docRef;
    this.currentCSSZoom = 1;
    this.offsetWidth = 0;
    this.clientWidth = 0;
  }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList = new FakeClassList(); this.classList.add(...String(v).split(/\s+/)); }
  get parentElement() { return this.parentNode instanceof FakeEl ? this.parentNode : null; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() {
    let n = this;
    while (n) { if (n === docRef.body || n === docRef.head) return true; n = n.parentNode; }
    return false;
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? docRef.createTextNode(c) : c); }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(o) { for (let n = o; n; n = n.parentNode) if (n === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  removeAttribute(k) { delete this.attrs[k]; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this._text = String(v ?? ""); for (const c of this.children) c.parentNode = null; this.children = []; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  focus() { docRef.activeElement = this; }
  blur() { if (docRef.activeElement === this) docRef.activeElement = docRef.body; }
  setPointerCapture() {}
  releasePointerCapture() {}
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: opt === true || !!opt?.capture }); }
  removeEventListener(type, fn, opt) {
    const capture = opt === true || !!opt?.capture;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
  matches(sel) { return String(sel).split(",").some((s) => matchSimple(this, s.trim())); }
  closest(sel) { for (let n = this; n instanceof FakeEl; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c instanceof FakeEl && c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function matchSimple(el, s) {
  if (!s || s.startsWith(":scope")) return false;
  if (s.includes(":focus-visible")) return false;
  const tag = /^[a-zA-Z][\w-]*/.exec(s);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  for (const m of s.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(m[1])) return false;
  for (const m of s.matchAll(/#([\w-]+)/g)) if (el.id !== m[1]) return false;
  for (const m of s.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)) {
    const name = m[1];
    let val;
    if (name.startsWith("data-")) {
      const k = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      val = el.dataset[k];
    } else {
      val = el.attrs[name];
    }
    if (val === undefined) return false;
    if (m[2] !== undefined && String(val) !== m[2]) return false;
  }
  return true;
}
/** document capture → target path capture → target/bubble → document bubble. */
function dispatch(target, type, init = {}) {
  const ev = {
    type, target, bubbles: true, defaultPrevented: false, _stop: false,
    button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", clientX: 0, clientY: 0,
    detail: 0, relatedTarget: null, repeat: false,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
    ...init,
  };
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  const run = (node, capture) => {
    for (const l of [...node.listeners]) {
      if (ev._stop) return;
      if (l.type === type && l.capture === capture) { ev.currentTarget = node; l.fn(ev); }
    }
  };
  run(docRef, true);
  for (let i = path.length - 1; i >= 0 && !ev._stop; i--) run(path[i], true);
  for (let i = 0; i < path.length && !ev._stop; i++) run(path[i], false);
  if (!ev._stop) run(docRef, false);
  return ev;
}

const document = {
  listeners: [],
  activeElement: null,
  visibilityState: "visible",
  createElement: (t) => new FakeEl(t),
  createTextNode: (t) => { const n = new FakeEl("#text"); n._text = String(t); return n; },
  getElementById(id) {
    const walk = (n) => { for (const c of n.children) { if (c.id === id) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(this.body) || walk(this.head);
  },
  querySelector(sel) { return this.body.querySelector(sel) || this.head.querySelector(sel); },
  querySelectorAll(sel) { return [...this.head.querySelectorAll(sel), ...this.body.querySelectorAll(sel)]; },
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: opt === true || !!opt?.capture }); },
  removeEventListener(type, fn, opt) {
    const capture = opt === true || !!opt?.capture;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  },
  dispatchEvent(ev) { for (const l of [...this.listeners]) if (l.type === ev.type) l.fn(ev); return true; },
};
docRef = document;
document.head = new FakeEl("head");
document.body = new FakeEl("body");
document.documentElement = new FakeEl("html");
document.activeElement = document.body;
globalThis.document = document;
globalThis.window = globalThis;
globalThis.innerWidth = 1600;
globalThis.innerHeight = 900;
globalThis.location = { search: "" };
// Window-level keydown listeners are recorded: the legacy (`?inputFunnelV2=off`)
// hotbar listener lives there.
const winKeydown = new Set();
globalThis.addEventListener = (type, fn) => { if (type === "keydown") winKeydown.add(fn); };
globalThis.removeEventListener = (type, fn) => { if (type === "keydown") winKeydown.delete(fn); };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = (el) => ({ backgroundImage: el.style.backgroundImage || "none", position: el.style.position || "static", paddingLeft: "0", paddingRight: "0" });
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

// ─── fake game session ────────────────────────────────────────────────
const PLAYER = 0x50000001;
const POTION = 0x7000AAA1; // hotbar slot 0 (row 1, key 1)
const KIT = 0x7000AAA2;    // hotbar slot 9 (row 2, key Alt+1)
const busHandlers = new Map();
window.__pluginClient = {
  events: {
    on(t, fn) { if (!busHandlers.has(t)) busHandlers.set(t, new Set()); busHandlers.get(t).add(fn); },
    off(t, fn) { busHandlers.get(t)?.delete(fn); },
    emit(t, d) { for (const fn of busHandlers.get(t) || []) fn(d); },
  },
};
window.__sessionHandle = {
  playerGuid: () => PLAYER,
  setCombatMode() {},
  playerInventory: () => [],
  useObject() {},
  moveItem() {},
  objectName: () => undefined,
  objectHealthFraction: () => -1,
  queryHealth() {},
  getSpellRecord: () => new Map(),
  addShortcut() {},
  removeShortcut() {},
  playerShortcuts: () => [],
  combatMode: () => 1,
};
window.__mainPanel = { toggleView() {}, isOpen: () => false, currentViewId: () => null };
window.liveScene3d = { entityManager: { getSelectedTarget: () => 0, entityMap: new Map() } };
const MAGIC = 0x49;
const NONCOMBAT = 0x3D;
let stance = NONCOMBAT;
window.__getCurrentStanceLow = () => stance;
const used = [];
window.__inventory = { activateItem: (g) => { used.push(g); return true; }, setArmedItem() {} };

const keymap = await import(pathToFileURL(resolvePath(APP, "ui/keymap.js")).href);
const funnelMod = await import(pathToFileURL(resolvePath(APP, "ui/input-funnel.js")).href);
const hotbar = await import(pathToFileURL(resolvePath(APP, "plugins/hotbar.js")).href);
const {
  LOCAL_ACTIONS, LOCAL_ACTION_IDS, resolveLocalBinding, formatBinding,
  readRetailQuickslotModsFlag, quickslotModDefault, _resetRetailQuickslotModsForTest,
} = keymap;

const funnel = funnelMod.getInputFunnel().setGate(() => true).install(document);
// combat-bar's UseSpellSlot_1..9 (installSpellBarHotkeys): bare digits,
// magic stance only. Registered BEFORE the hotbar, so it is checked first.
const spellSlots = [];
for (let n = 1; n <= 9; n++) {
  funnel.bindAction(LOCAL_ACTION_IDS[`MAGIC_SLOT_${n}`], `Digit${n}`, () => spellSlots.push(n - 1), {
    when: () => stance === MAGIC,
    source: "combat-bar",
  });
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  [PASS] ${name}`); }
  catch (e) { fail += 1; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
function eq(a, b, label = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${label} expected ${y}, got ${x}`); }

/** Press + release a digit key (with modifiers) on the document body. */
function press(n, mods = {}) {
  const init = {
    key: String(n), code: `Digit${n}`,
    ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
    repeat: !!mods.repeat,
  };
  const ev = dispatch(document.body, "keydown", init);
  dispatch(document.body, "keyup", { ...init, repeat: false });
  return ev;
}
const last = () => funnel.lastDispatch;

console.log("[1] keymap rows (retail gmDefaultMap Quickslot 1-18)");
check("Ctrl rows default to Ctrl+DigitN; resolveLocalBinding carries ctrl", () => {
  for (let n = 1; n <= 9; n++) {
    const id = LOCAL_ACTION_IDS[`HOTBAR_CTRL_${n}`];
    const row = LOCAL_ACTIONS.find((a) => a.labelHash === id);
    eq(!!row, true, `row ${id}`);
    eq(row.defaultCode, { code: `Digit${n}`, ctrl: true }, `default ${n}`);
    eq(resolveLocalBinding(id, row.defaultCode),
      { code: `Digit${n}`, shift: false, ctrl: true, alt: false, meta: false }, `resolved ${n}`);
  }
  eq(formatBinding(resolveLocalBinding(LOCAL_ACTION_IDS.HOTBAR_CTRL_1, quickslotModDefault(1, "ctrl"))), "Ctrl+1");
});
check("row 2 defaults to Alt+1..Alt+9 (no longer unbound)", () => {
  for (let n = 1; n <= 9; n++) {
    const id = LOCAL_ACTION_IDS[`HOTBAR_R2_${n}`];
    const row = LOCAL_ACTIONS.find((a) => a.labelHash === id);
    eq(row.defaultCode, { code: `Digit${n}`, alt: true }, `default ${n}`);
  }
  eq(formatBinding(resolveLocalBinding(LOCAL_ACTION_IDS.HOTBAR_R2_9, quickslotModDefault(9, "alt"))), "Alt+9");
});
check("row 1 keeps the bare digits; magic Spell Slot rows unchanged", () => {
  for (let n = 1; n <= 9; n++) {
    eq(LOCAL_ACTIONS.find((a) => a.labelHash === LOCAL_ACTION_IDS[`HOTBAR_${n}`]).defaultCode, `Digit${n}`);
    eq(LOCAL_ACTIONS.find((a) => a.labelHash === LOCAL_ACTION_IDS[`MAGIC_SLOT_${n}`]).defaultCode, `Digit${n}`);
  }
});
check("LOCAL_ACTIONS labelHashes are unique and every LOCAL_ACTION_IDS value has a row", () => {
  const hashes = LOCAL_ACTIONS.map((a) => a.labelHash);
  eq(new Set(hashes).size, hashes.length, "unique");
  for (const [k, v] of Object.entries(LOCAL_ACTION_IDS)) {
    if (!hashes.includes(v)) throw new Error(`${k} = ${v} has no LOCAL_ACTIONS row`);
  }
});
check("?retailQuickslotMods flag: default ON, off/0/false disable", () => {
  eq(readRetailQuickslotModsFlag(""), true, "absent");
  eq(readRetailQuickslotModsFlag("?retailQuickslotMods=on"), true, "on");
  eq(readRetailQuickslotModsFlag("?nosw=1"), true, "unrelated");
  eq(readRetailQuickslotModsFlag("?retailQuickslotMods=off"), false, "off");
  eq(readRetailQuickslotModsFlag("?retailQuickslotMods=OFF"), false, "OFF");
  eq(readRetailQuickslotModsFlag("?retailQuickslotMods=0"), false, "0");
  eq(readRetailQuickslotModsFlag("?retailQuickslotMods=false"), false, "false");
  eq(quickslotModDefault(3, "alt", "?retailQuickslotMods=off"), null, "off → unbound");
  eq(quickslotModDefault(3, "alt", ""), { code: "Digit3", alt: true }, "on → Alt+3");
});

console.log("\n[2] funnel dispatch with the real hotbar mounted");
let dispose = hotbar.mount({ client: window.__pluginClient });
window.__hotbar.bindItemToSlot(0, POTION);
window.__hotbar.bindItemToSlot(9, KIT);
const slotEl = (i) => document.getElementById("hb-hotbar").querySelectorAll(".hb-hotbar-slot")[i];

check("outside magic stance: bare 1 fires hotbar slot 0", () => {
  stance = NONCOMBAT;
  used.length = 0; spellSlots.length = 0;
  const ev = press(1);
  eq(used, [POTION], "potion used");
  eq(spellSlots, [], "no spell slot");
  eq(last().source, "hotbar", "source");
  eq(last().labelHash, LOCAL_ACTION_IDS.HOTBAR_1, "action");
  eq(ev.defaultPrevented, true, "preventDefault");
});
check("outside magic stance: Ctrl+1 also fires slot 0 (and is preventDefault-ed)", () => {
  used.length = 0;
  const ev = press(1, { ctrl: true });
  eq(used, [POTION], "potion used");
  eq(last().labelHash, LOCAL_ACTION_IDS.HOTBAR_CTRL_1, "Ctrl alias action");
  eq(ev.defaultPrevented, true, "tab switch blocked");
});
check("magic stance: bare 1 goes to combat-bar Spell Slot 1, not the hotbar", () => {
  stance = MAGIC;
  used.length = 0; spellSlots.length = 0;
  press(1);
  eq(spellSlots, [0], "spell slot 0");
  eq(used, [], "no potion");
  eq(last().source, "combat-bar", "source");
});
check("magic stance: Ctrl+1 fires hotbar slot 0 (retail's way to row 1 there)", () => {
  used.length = 0; spellSlots.length = 0;
  const ev = press(1, { ctrl: true });
  eq(used, [POTION], "potion used");
  eq(spellSlots, [], "no spell");
  eq(last().source, "hotbar", "source");
  eq(last().labelHash, LOCAL_ACTION_IDS.HOTBAR_CTRL_1, "action");
  eq(ev.defaultPrevented, true, "preventDefault");
});
check("magic stance: Alt+1 fires hotbar slot 9 (row 2 does not yield to the spell bar)", () => {
  used.length = 0; spellSlots.length = 0;
  const ev = press(1, { alt: true });
  eq(used, [KIT], "kit used");
  eq(spellSlots, [], "no spell");
  eq(last().labelHash, LOCAL_ACTION_IDS.HOTBAR_R2_1, "action");
  eq(ev.defaultPrevented, true, "preventDefault");
});
check("outside magic stance: Alt+1 fires slot 9", () => {
  stance = NONCOMBAT;
  used.length = 0;
  press(1, { alt: true });
  eq(used, [KIT], "kit used");
});
check("a held Ctrl+1 uses the item once (autorepeat consumed)", () => {
  used.length = 0;
  const down = { key: "1", code: "Digit1", ctrlKey: true };
  dispatch(document.body, "keydown", down);
  const rep = dispatch(document.body, "keydown", { ...down, repeat: true });
  dispatch(document.body, "keydown", { ...down, repeat: true });
  dispatch(document.body, "keyup", down);
  eq(used, [POTION], "once");
  eq(rep.defaultPrevented, true, "repeat consumed");
});
check("Ctrl+Alt+1 (AltGr) and Shift+1 match nothing", () => {
  used.length = 0;
  const a = press(1, { ctrl: true, alt: true });
  const s = press(1, { shift: true });
  eq(used, [], "nothing fired");
  eq([a.defaultPrevented, s.defaultPrevented], [false, false], "browser keeps them");
});
check("row 2 tooltip names the Alt key", () => {
  eq(slotEl(9)._hbTip().key, "Alt+1", "slot 10");
  eq(slotEl(0)._hbTip().key, "1", "slot 1");
});
check("a user rebind of the Ctrl row to a bare digit yields in magic stance like row 1", () => {
  // Free Digit5 first (row 1 slot 5 owns it and is checked earlier).
  keymap.setBinding(LOCAL_ACTION_IDS.HOTBAR_5, { code: "KeyG" });
  keymap.setBinding(LOCAL_ACTION_IDS.HOTBAR_CTRL_1, { code: "Digit5" });
  try {
    stance = MAGIC;
    used.length = 0; spellSlots.length = 0;
    press(5);
    eq(spellSlots, [4], "spell slot 5 owns the bare digit");
    eq(used, [], "no potion");
    stance = NONCOMBAT;
    press(5);
    eq(used, [POTION], "outside magic the rebound key fires slot 0");
  } finally {
    keymap.clearBinding(LOCAL_ACTION_IDS.HOTBAR_CTRL_1);
    keymap.clearBinding(LOCAL_ACTION_IDS.HOTBAR_5);
  }
});
dispose();

console.log("\n[3] ?retailQuickslotMods=off — Ctrl/Alt rows unbound (old keys)");
globalThis.location = { search: "?retailQuickslotMods=off" };
_resetRetailQuickslotModsForTest();
dispose = hotbar.mount({ client: window.__pluginClient });
check("table defaults read the flag (Options → Controls shows them unbound)", () => {
  eq(LOCAL_ACTIONS.find((a) => a.labelHash === LOCAL_ACTION_IDS.HOTBAR_CTRL_1).defaultCode, null, "Ctrl row");
  eq(LOCAL_ACTIONS.find((a) => a.labelHash === LOCAL_ACTION_IDS.HOTBAR_R2_1).defaultCode, null, "row 2");
});
check("Ctrl+1 / Alt+1 fire nothing and are left to the browser; bare 1 still works", () => {
  stance = NONCOMBAT;
  used.length = 0;
  const c = press(1, { ctrl: true });
  const a = press(1, { alt: true });
  eq(used, [], "nothing fired");
  eq([c.defaultPrevented, a.defaultPrevented], [false, false], "not prevented");
  press(1);
  eq(used, [POTION], "bare digit");
});
check("row 2 tooltip has no key", () => {
  eq(slotEl(9)._hbTip().key, "", "unbound");
});
dispose();
globalThis.location = { search: "" };
_resetRetailQuickslotModsForTest();

console.log("\n[4] ?inputFunnelV2=off — the legacy hotbar listener");
globalThis.location = { search: "?inputFunnelV2=off" };
funnelMod._resetInputFunnelV2ForTest();
dispose = hotbar.mount({ client: window.__pluginClient });
/** Feed a keydown straight to the window-level listeners (the legacy path). */
function pressLegacy(n, mods = {}) {
  const ev = {
    type: "keydown", target: document.body, key: String(n), code: `Digit${n}`,
    ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: false, metaKey: false,
    repeat: !!mods.repeat, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  for (const fn of [...winKeydown]) fn(ev);
  return ev;
}
check("legacy listener installed", () => eq(winKeydown.size, 1, "one keydown listener"));
check("magic stance: bare 1 yields, Ctrl+1 fires slot 0, Alt+1 fires slot 9", () => {
  stance = MAGIC;
  used.length = 0;
  const bare = pressLegacy(1);
  eq(used, [], "bare digit yields to the spell bar");
  eq(bare.defaultPrevented, false, "bare digit untouched");
  const c = pressLegacy(1, { ctrl: true });
  const a = pressLegacy(1, { alt: true });
  eq(used, [POTION, KIT], "Ctrl → slot 0, Alt → slot 9");
  eq([c.defaultPrevented, a.defaultPrevented], [true, true], "tab-switch combos kept");
});
check("outside magic stance: bare 1 fires slot 0 (unchanged legacy behaviour)", () => {
  stance = NONCOMBAT;
  used.length = 0;
  const ev = pressLegacy(1);
  eq(used, [POTION], "fired");
  eq(ev.defaultPrevented, false, "bare digit not prevented (as before)");
  pressLegacy(1, { ctrl: true, repeat: true });
  eq(used, [POTION], "autorepeat does not re-fire");
});
dispose();
check("legacy listener removed on dispose", () => eq(winKeydown.size, 0, "none left"));
globalThis.location = { search: "" };
funnelMod._resetInputFunnelV2ForTest();

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
