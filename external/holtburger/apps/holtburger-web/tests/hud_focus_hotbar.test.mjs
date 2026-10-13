// tests/hud_focus_hotbar.test.mjs — input-options-1 (2026-10-13), end to end.
//
// Mounts the REAL plugins/hotbar.js (+ target-bar.js's toolbar controls)
// against a small fake DOM that tracks document.activeElement and routes
// events document-capture → target → bubble, with the REAL InputFunnel
// installed on the document and a stand-in for index.html's Space branch.
//
// The bug: click a potion, then jump — the focused slot fired again on every
// Space (another potion); click the target name, then jump — every jump
// examined (the examine toggle open/closed). Retail panels never hold the
// keyboard (CInputManager → ACCmdInterp::OnAction, acclient.c:435951).
//
// Run from apps/holtburger-web/:  node tests/hud_focus_hotbar.test.mjs

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// ─── fake DOM (after test_toolbar_mount_smoke.mjs, plus focus tracking) ──
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
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
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
const MOB = 0x80000AAA;
const POTION = 0x7000BBBB;
let selected = 0;
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
  objectName: (g) => (g === MOB ? "Drudge Skulker" : g === POTION ? "Healing Potion" : undefined),
  objectHealthFraction: () => -1,
  queryHealth() {},
  getSpellRecord: () => new Map(),
  addShortcut() {},
  removeShortcut() {},
  playerShortcuts: () => [],
  combatMode: () => 1,
};
window.__mainPanel = { toggleView() {}, isOpen: () => false, currentViewId: () => null };
window.liveScene3d = { entityManager: { getSelectedTarget: () => selected, entityMap: new Map() } };
window.__getCurrentStanceLow = () => 0x3D;
const drunk = [];
window.__inventory = { activateItem: (g) => { drunk.push(g); return true; }, setArmedItem() {} };
const examined = [];
window.__showExamineFor = (g) => examined.push(g);

const { getInputFunnel } = await import(pathToFileURL(resolvePath(APP, "ui/input-funnel.js")).href);
const hotbar = await import(pathToFileURL(resolvePath(APP, "plugins/hotbar.js")).href);
const targetBar = await import(pathToFileURL(resolvePath(APP, "plugins/target-bar.js")).href);

// The ONE funnel on the document (capture), gate open (in world), with
// index.html __gameplayKeyDown's Space branch: repeats consumed, the press
// edge starts the jump and preventDefaults.
const funnel = getInputFunnel().setGate(() => true).install(document);
let jumps = 0;
funnel.bindRaw("index.gameplay", (ev) => {
  if (ev.key === " " && ev.repeat) ev.preventDefault();
  if (ev.key === " " && !ev.repeat) { jumps += 1; ev.preventDefault(); }
}, { priority: 100 });

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  [PASS] ${name}`); }
  catch (e) { fail += 1; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
function eq(a, b, label = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${label} expected ${y}, got ${x}`); }

/** A real mouse click: pointerdown, mousedown's default focuses, pointerup, click. */
function mouseClick(el) {
  dispatch(el, "pointerdown", { buttons: 1 });
  el.focus();
  dispatch(el, "pointerup");
  dispatch(el, "click", { detail: 1 });
}
/** A keydown goes to the focused element (body when nothing is). */
function press(k, opts = {}) {
  return dispatch(document.activeElement || document.body, "keydown", {
    key: k, code: k === " " ? "Space" : k, ...opts,
  });
}
/** The matching key-up (keeps the funnel's held-key ledger honest). */
function release(k) {
  return dispatch(document.activeElement || document.body, "keyup", {
    key: k, code: k === " " ? "Space" : k,
  });
}

const disposeTargetBar = targetBar.mount({});
const dispose = hotbar.mount({ client: window.__pluginClient });
const field = document.getElementById("hb-hotbar")?.querySelector(".hb-hotbar-field");
window.__hotbar.bindItemToSlot(2, POTION);
const slot = field.querySelectorAll(".hb-hotbar-slot")[2];
const targetEl = field.querySelector(".htb-target");

console.log("[1] Hotbar slot");
check("clicking a potion drinks it once and leaves the slot unfocused", () => {
  mouseClick(slot);
  eq(drunk, [POTION], "one drink");
  eq(document.activeElement === slot, false, "slot released the keyboard");
});
check("then jumping (Space press + autorepeat) drinks nothing more", () => {
  const j = jumps;
  press(" ");
  press(" ", { repeat: true });
  press(" ", { repeat: true });
  release(" ");
  eq(jumps, j + 1, "one jump");
  eq(drunk, [POTION], "no extra potion");
});
check("a slot that still holds focus (Tab) stands down on the jump's Space", () => {
  slot.focus();
  const ev = press(" ");
  release(" ");
  eq(ev.defaultPrevented, true, "the jump consumed Space");
  eq(drunk, [POTION], "the funnel's Space never reaches the slot as an activation");
});
check("…but Enter on a Tab-focused slot still fires it once (keyboard access kept)", () => {
  slot.focus();
  press("Enter");
  eq(drunk, [POTION, POTION], "Enter fires the focused slot");
  press("Enter", { repeat: true });
  release("Enter");
  eq(drunk, [POTION, POTION], "autorepeat does not");
  slot.blur();
});
check("press on the slot, release elsewhere (no click) also releases focus", () => {
  dispatch(slot, "pointerdown", { buttons: 1 });
  slot.focus();
  dispatch(document.body, "pointerup");
  eq(document.activeElement === slot, false, "blurred");
  eq(drunk.length, 2, "nothing fired");
});

console.log("\n[2] Selected-object field");
check("clicking the target name examines once; jumping afterwards does not re-examine", () => {
  selected = MOB;
  window.__pluginClient.events.emit("selectionChanged", { guid: MOB });
  mouseClick(targetEl);
  eq(examined, [MOB], "one examine");
  eq(document.activeElement === targetEl, false, "field released the keyboard");
  press(" ");
  release(" ");
  targetEl.focus(); // even if it somehow kept focus
  press(" ");
  release(" ");
  eq(examined, [MOB], "no examine from the jump");
  targetEl.blur();
});

console.log("\n[3] Dispose");
check("hotbar + toolbar dispose cleanly", () => {
  dispose();
  disposeTargetBar();
  eq(document.getElementById("hb-hotbar"), null, "root");
});

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
