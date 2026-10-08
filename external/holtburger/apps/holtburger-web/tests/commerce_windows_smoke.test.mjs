// tests/commerce_windows_smoke.test.mjs — HUD overhaul 2026-10-05.
//
// Headless smoke test for the six commerce / crafting / reading windows
// (vendor-ui, trade-panel, salvage-panel, tinker-panel, book-panel,
// house-panel) and their shared plumbing (plugins/commerce_window.js). No
// browser: a ~200-line fake DOM below is just enough for the windows to
// build, render and dispatch. What it pins:
//
//   [1] every window mounts as a direct <body> child with an `hb-` id (so
//       ui/hud_scale.js zooms it and agent-mode keeps it visible) and kit
//       chrome, and opens/closes through data-open;
//   [2] each window drives the SAME wire calls as before the rebuild
//       (buyFromVendor / sellToVendor / addToTrade / acceptTrade /
//       declineTrade / resetTrade / createTinkeringTool / useWithTarget /
//       bookModifyPage / houseQuery) with the same argument shapes;
//   [3] player-facing text never shows a raw hex guid;
//   [4] Esc closes only the TOPMOST window.
//
// Run from apps/holtburger-web/:  node tests/commerce_windows_smoke.test.mjs

import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.stack?.split("\n").slice(0, 3).join(" | ") ?? err}`);
  }
}

/* ── fake DOM ─────────────────────────────────────────────────────────── */

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.defaultPrevented = false;
    this._stop = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; }
}
class FakeCustomEvent extends FakeEvent {
  constructor(type, init = {}) { super(type, init); this.detail = init.detail; }
}

function parseSimple(sel) {
  // tag? #id? .class* [attr(="v")]*
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(sel)) !== null) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push([m[4], m[5]]);
  }
  return out;
}
function matchesSimple(el, s) {
  if (!el || el.nodeType !== 1) return false;
  if (s.tag && el.tagName !== s.tag) return false;
  if (s.id && el.id !== s.id) return false;
  for (const c of s.classes) if (!el.classList.contains(c)) return false;
  for (const [a, v] of s.attrs) {
    const got = el.getAttribute(a);
    if (got == null) return false;
    if (v !== undefined && got !== v) return false;
  }
  return true;
}
function matches(el, selector) {
  return selector.split(",").map((x) => x.trim()).some((one) => matchesSimple(el, parseSimple(one)));
}

class FakeClassList {
  constructor(el) { this.el = el; }
  _get() { return String(this.el.className || "").split(/\s+/).filter(Boolean); }
  _set(a) { this.el.className = a.join(" "); }
  add(...c) { const a = this._get(); for (const x of c) if (!a.includes(x)) a.push(x); this._set(a); }
  remove(...c) { this._set(this._get().filter((x) => !c.includes(x))); }
  contains(c) { return this._get().includes(c); }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(c);
    if (!want && has) this.remove(c);
    return want;
  }
}

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this._listeners = {}; }
  get isConnected() {
    let n = this;
    while (n) { if (n === n.ownerDocument?.documentElement || n.isDocument) return true; n = n.parentNode; }
    return false;
  }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    ev.target = ev.target ?? this;
    let n = this;
    while (n) {
      ev.currentTarget = n;
      for (const fn of [...(n._listeners[ev.type] || [])]) fn.call(n, ev);
      if (ev._stop || !ev.bubbles) break;
      n = n.parentNode ?? (n.isDocument ? n.defaultView : null);
    }
    return !ev.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  constructor(doc, text) { super(doc); this.nodeType = 3; this.data = String(text); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  remove() { this.parentNode?.removeChild(this); }
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.id = "";
    this.className = "";
    this.attributes = {};
    this.dataset = {};
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.classList = new FakeClassList(this);
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.title = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get options() { return this.children.filter((c) => c.tagName === "OPTION"); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== "" && v != null) this.appendChild(new FakeText(this.ownerDocument, v));
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) {
    if (k === "id") return this.id || null;
    if (k === "class") return this.className || null;
    if (k.startsWith("data-")) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] ?? null;
    }
    return this.attributes[k] ?? null;
  }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return this.getAttribute(k) != null; }
  _adopt(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    return c;
  }
  appendChild(c) { if (!c) return c; this._adopt(c); this.childNodes.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === "string" ? new FakeText(this.ownerDocument, c) : c); }
  prepend(c) { this._adopt(c); this.childNodes.unshift(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...cs) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const c of cs) if (c) this.appendChild(c);
  }
  replaceWith(n) {
    const p = this.parentNode; if (!p) return;
    const i = p.childNodes.indexOf(this);
    this.parentNode = null;
    p._adopt(n);
    p.childNodes.splice(i, 1, n);
  }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
  matches(sel) { return matches(this, sel); }
  _walk(fn) { for (const c of this.children) { fn(c); c._walk(fn); } }
  querySelectorAll(sel) {
    const out = [];
    if (sel.startsWith(":scope >")) {
      const rest = sel.slice(8).trim();
      for (const c of this.children) if (matches(c, rest)) out.push(c);
      return out;
    }
    this._walk((c) => { if (matches(c, sel)) out.push(c); });
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200, x: 0, y: 0 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  get clientWidth() { return 200; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  click() { this.dispatchEvent(new FakeEvent("click")); }
  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() {}
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.isDocument = true;
    this.ownerDocument = this;
    this.documentElement = new FakeElement(this, "html");
    this.documentElement.parentNode = this;
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(t) { return new FakeText(this, t); }
  getElementById(id) { let hit = null; this.documentElement._walk((c) => { if (!hit && c.id === id) hit = c; }); return hit; }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
}

const document = new FakeDocument();
const store = new Map();
const windowObj = {
  document,
  innerWidth: 1280,
  innerHeight: 720,
  location: { search: "" },
  _listeners: {},
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); },
  removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn); },
  dispatchEvent(ev) { ev.target ??= windowObj; for (const fn of [...(this._listeners[ev.type] || [])]) fn(ev); return true; },
};
document.defaultView = windowObj;
Object.assign(globalThis, {
  document,
  window: windowObj,
  CustomEvent: FakeCustomEvent,
  Event: FakeEvent,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
});

/* ── fake session + bus ───────────────────────────────────────────────── */

const calls = [];
const bus = {
  l: {},
  on(n, fn) { (this.l[n] ||= []).push(fn); },
  off(n, fn) { this.l[n] = (this.l[n] || []).filter((f) => f !== fn); },
  emit(n, payload) { for (const fn of [...(this.l[n] || [])]) fn(new FakeCustomEvent(n, { detail: payload })); },
};
const PLAYER = 0x50000001;
const inv = [
  { guid: 0x80000001, wcid: 273, name: "Pyreal", value: 5000, stackSize: 5000, itemType: 0x40, iconId: 0, equipMask: 0, containerId: PLAYER },
  { guid: 0x80000002, wcid: 100, name: "Iron Dagger", value: 80, stackSize: 1, itemType: 0x01, iconId: 0, equipMask: 0, containerId: PLAYER },
  { guid: 0x80000003, wcid: 101, name: "Worn Robe", value: 30, stackSize: 1, itemType: 0x04, iconId: 0, equipMask: 0x200, containerId: PLAYER },
  { guid: 0x80000004, wcid: 102, name: "Ust", value: 10, stackSize: 1, itemType: 0x20000000, iconId: 0, equipMask: 0, containerId: PLAYER },
];
let book = {
  objectGuid: 0x80000010, authorName: "Gaerlan", inscription: "", maxCharsPerPage: 1000, maxNumPages: 10,
  pages: [{ text: "The first page.", authorName: "Gaerlan" }, { text: "The second page.", authorName: "Gaerlan" }],
};
let trade = null;
const handle = {
  playerInventory: () => inv.map((i) => ({ ...i })),
  objectName: (g) => ({ 0x80000010: "Tome of Lore", 0x70000001: "Lin the Trader", 0x60000001: "Covenant Crystal" })[g >>> 0]
    ?? inv.find((i) => i.guid === (g >>> 0))?.name,
  getObjectIconId: () => 0,
  getObjectAppraisal: () => undefined,
  buyFromVendor: (v, g, a) => calls.push(["buyFromVendor", v, Array.from(g), Array.from(a), g.constructor.name, a.constructor.name]),
  sellToVendor: (v, g, a) => calls.push(["sellToVendor", v, Array.from(g), Array.from(a), g.constructor.name, a.constructor.name]),
  getVendorState: () => null,
  playerTrade: () => trade,
  addToTrade: (g, s) => calls.push(["addToTrade", g, s]),
  acceptTrade: () => calls.push(["acceptTrade"]),
  declineTrade: () => calls.push(["declineTrade"]),
  resetTrade: () => calls.push(["resetTrade"]),
  closeTrade: () => { calls.push(["closeTrade"]); trade = null; bus.emit("tradeUpdated", {}); },
  createTinkeringTool: (t, items) => calls.push(["createTinkeringTool", t, Array.from(items), items.constructor.name]),
  useWithTarget: (a, b) => calls.push(["useWithTarget", a, b]),
  playerBook: () => book,
  bookData: (g) => calls.push(["bookData", g]),
  bookModifyPage: (g, p, ia, text) => calls.push(["bookModifyPage", g, p, ia, text]),
  bookAddPage: (g) => calls.push(["bookAddPage", g]),
  setInscription: (g, t) => calls.push(["setInscription", g, t]),
  playerHouseStatus: () => ({ errorCode: 0, isHouseOwner: true, free() {} }),
  playerHouseData: () => ({ houseType: 1, landblockId: 0xA9B40019, posX: 100, posY: 50, posZ: 0, buyTime: 1_700_000_000,
    rentTime: Math.floor(Date.now() / 1000) - 86400, maintenanceFree: false, free() {} }),
  playerHouseProfile: () => undefined,
  playerHouseRestrictions: () => ({ isOpen: false, guestCount: 2, storageCount: 1, version: 1, free() {} }),
  houseQuery: () => calls.push(["houseQuery"]),
};
Object.assign(windowObj, {
  __sessionHandle: handle,
  __pluginClient: { events: bus },
  getLocalPlayerGuid: () => PLAYER,
});

/* ── load the plugins (real modules, real commerce_window) ────────────── */

const vendor = await import("../plugins/vendor-ui.js");
await import("../plugins/trade-panel.js");
const salvage = await import("../plugins/salvage-panel.js");
const tinker = await import("../plugins/tinker-panel.js");
await import("../plugins/book-panel.js");
await import("../plugins/house-panel.js");
const cw = await import("../plugins/commerce_window.js");

const HEX = /0x[0-9a-f]{6,8}/i;
const byId = (id) => document.getElementById(id);
const isOpen = (id) => byId(id)?.dataset.open === "1";
const text = (id) => byId(id)?.textContent ?? "";
function findButton(root, label) {
  let hit = null;
  root._walk((c) => { if (!hit && c.tagName === "BUTTON" && c.textContent.trim() === label) hit = c; });
  return hit;
}

/* ── [1] vendor ───────────────────────────────────────────────────────── */
console.log("[vendor]");
vendor.mount({ client: { events: bus } });
await check("opens as a direct <body> child #hb-vendor-bar with kit chrome", () => {
  window.__vendorPluginDebug.open({
    vendorGuid: 0x70000001, vendorName: "Lin the Trader",
    buyMultiplier: 0.9, sellMultiplier: 1.5,
    alternateCurrencyWcid: 0, alternateCurrencyAmount: 0, alternateCurrencyName: "",
    items: [
      { itemGuid: 0x90000001, wcid: 1, name: "Bread", value: 10, stackSize: 1, itemType: 0x20, iconId: 0 },
      { itemGuid: 0x90000002, wcid: 2, name: "Healing Kit", value: 100, stackSize: 1, itemType: 0x80, iconId: 0 },
    ],
  });
  const root = byId("hb-vendor-bar");
  assert.ok(root, "root exists");
  assert.equal(root.parentNode, document.body);
  assert.ok(root.classList.contains("hbk-window"));
  assert.ok(isOpen("hb-vendor-bar"));
});
await check("title = vendor name, purse = 5,000 p, prices use the SELL rate (Healing Kit 150)", () => {
  const t = text("hb-vendor-bar");
  assert.match(t, /Lin the Trader/);
  assert.match(t, /5,000 p/);
  const cell = byId("hb-vendor-bar").querySelectorAll(".hvb-cell").find((c) => c.dataset.itemGuid === String(0x90000002));
  assert.equal(cell.querySelector(".hb-cw-caption").textContent, "150",
    "Healing Kit at sell_price 1.5 = 150 p (NEGATIVE CONTROL: the old bar showed 90)");
  assert.match(t, /Sells at 150% · buys at 90%/);
  assert.doesNotMatch(t, HEX);
});
await check("select + Buy sends buyFromVendor(vendor, Uint32Array[item], Int32Array[qty])", () => {
  calls.length = 0;
  const cell = byId("hb-vendor-bar").querySelectorAll(".hvb-cell").find((c) => c.dataset.itemGuid === String(0x90000002));
  assert.ok(cell, "stock cell rendered");
  cell.click();
  assert.match(text("hb-vendor-bar"), /Price/);
  findButton(byId("hb-vendor-bar"), "Buy").click();
  assert.deepEqual(calls[0].slice(0, 4), ["buyFromVendor", 0x70000001, [0x90000002], [1]]);
  assert.equal(calls[0][4], "Uint32Array");
  assert.equal(calls[0][5], "Int32Array");
});
await check("drag-to-sell: equipped item refused, dagger staged at the BUY rate (72), Sell All wires sellToVendor", () => {
  calls.length = 0;
  window.__vendorPluginDebug.stageSell(0x80000003); // equipped robe
  window.__vendorPluginDebug.stageSell(0x80000002); // dagger
  const t = text("hb-vendor-bar");
  assert.match(t, /Selling \(1\)/);
  assert.match(t, /72 p/, "80 × 0.9 = 72");
  findButton(byId("hb-vendor-bar"), "Sell All").click();
  assert.deepEqual(calls[0].slice(0, 4), ["sellToVendor", 0x70000001, [0x80000002], [1]]);
});
await check("items-1: a dropped pack sells its accepted contents, whole stacks, no quantity box", () => {
  // VendorSellUI::DragItemAcceptable + gmVendorUI::AddItem(_addContents=1):
  // the pack is not staged, each accepted child is; ACE sells whole stacks.
  const PACK = 0x80000020;
  const extra = [
    { guid: PACK, wcid: 136, name: "Sack", value: 50, stackSize: 1, itemType: 0x200, iconId: 0, equipMask: 0, containerId: PLAYER },
    { guid: 0x80000021, wcid: 300, name: "Arrow", value: 500, stackSize: 100, itemType: 0x100, iconId: 0, equipMask: 0, containerId: PACK },
    { guid: 0x80000022, wcid: 301, name: "Mace", value: 90, stackSize: 1, itemType: 0x01, iconId: 0, equipMask: 0, containerId: PACK },
  ];
  inv.push(...extra);
  try {
    calls.length = 0;
    window.__vendorPluginDebug.stageSell(PACK);
    const root = byId("hb-vendor-bar");
    const t = text("hb-vendor-bar");
    assert.match(t, /Selling \(2\)/);
    assert.match(t, /Selling contents of Sack/, "retail notice");
    const rows = root.querySelectorAll(".hvb-row").map((r) => r.textContent);
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => /Arrow/.test(r)) && rows.some((r) => /Mace/.test(r)), rows.join(" | "));
    assert.ok(!rows.some((r) => /Sack/.test(r)), "the pack itself is not staged");
    assert.match(rows.find((r) => /Arrow/.test(r)), /x100/, "the whole stack");
    assert.equal(root.querySelectorAll(".hvb-row input").length, 0, "sell rows have no quantity box");
    findButton(root, "Sell All").click();
    assert.deepEqual(calls[0].slice(0, 4), ["sellToVendor", 0x70000001, [0x80000021, 0x80000022], [100, 1]]);
  } finally {
    inv.splice(inv.length - extra.length, extra.length);
  }
});
await check("Buying tab empty state is player-facing text", () => {
  window.__vendorPluginDebug.switchTab("buying");
  assert.match(text("hb-vendor-bar"), /buying list is empty/i);
});
await check("Add to List ×3 → Buying shows qty, total 450 p and Buy All sends amounts [3]", () => {
  calls.length = 0;
  window.__vendorPluginDebug.switchTab("items");
  const root = byId("hb-vendor-bar");
  root.querySelectorAll(".hvb-cell").find((c) => c.dataset.itemGuid === String(0x90000002)).click();
  const qty = window.__vendorPluginDebug.refs().qtyInput;
  qty.value = "3";
  qty.dispatchEvent(new FakeEvent("input"));
  findButton(root, "Add to List").click();
  window.__vendorPluginDebug.switchTab("buying");
  const t = text("hb-vendor-bar");
  assert.match(t, /Buying \(1\)/);
  assert.match(t, /450 p/, "3 × 150");
  assert.match(t, /Remaining/);
  findButton(root, "Buy All").click();
  assert.deepEqual(calls[0].slice(0, 4), ["buyFromVendor", 0x70000001, [0x90000002], [3]]);
});

/* ── [2] trade ────────────────────────────────────────────────────────── */
console.log("[trade]");
await check("snapshot renders both halves, accept badges and a plain status line", () => {
  trade = {
    partnerGuid: 0x50000002, partnerName: "Bob", myAccepted: false, partnerAccepted: true,
    myItems: [{ guid: 0x80000002, name: "Iron Dagger", iconId: 0, stackSize: 1 }],
    partnerItems: [{ guid: 0x80000099, name: "Gold Ring", iconId: 0, stackSize: 1 }],
  };
  bus.emit("tradeUpdated", {});
  assert.ok(isOpen("hb-trade-panel"));
  const t = text("hb-trade-panel");
  assert.match(t, /Trading with Bob/);
  assert.match(t, /Bob has accepted/);
  assert.match(t, /Items offered: 1/);
  assert.doesNotMatch(t, HEX);
});
await check("Trade toggles accept → decline (retail toggle), Clear All → resetTrade", () => {
  calls.length = 0;
  const root = byId("hb-trade-panel");
  root.querySelector(".htp-trade").click();
  assert.deepEqual(calls.at(-1), ["acceptTrade"]);
  trade = { ...trade, myAccepted: true };
  bus.emit("tradeUpdated", {});
  assert.match(text("hb-trade-panel"), /Accepted/);
  root.querySelector(".htp-trade").click();
  assert.deepEqual(calls.at(-1), ["declineTrade"]);
  root.querySelector(".htp-clear").click();
  assert.deepEqual(calls.at(-1), ["resetTrade"]);
});
await check("dropping an inventory item offers it via addToTrade(guid, 0)", () => {
  calls.length = 0;
  const well = byId("hb-trade-panel").querySelector(".htp-mine").querySelector(".htp-well");
  const dt = {
    types: ["application/x-hb-inv-guid"],
    getData: (m) => (m === "application/x-hb-inv-guid" ? String(0x80000001) : ""),
  };
  well.dispatchEvent(new FakeEvent("dragenter", { dataTransfer: dt }));
  const root = byId("hb-trade-panel");
  assert.ok(well.classList.contains("is-drop-target") && root.classList.contains("is-drop-target"),
    "well and window both light up");
  well.dispatchEvent(new FakeEvent("drop", { dataTransfer: dt }));
  assert.deepEqual(calls[0], ["addToTrade", 0x80000001, 0]);
  assert.equal(calls.filter((c) => c[0] === "addToTrade").length, 1, "nested targets fire the drop once");
  assert.ok(!well.classList.contains("is-drop-target") && !root.classList.contains("is-drop-target"),
    "both highlights clear after the drop");
});

/* ── [3] salvage ──────────────────────────────────────────────────────── */
console.log("[salvage]");
salvage.mount({ client: { events: bus } });
await check("opens with the retail warning and the tool's NAME", () => {
  window.__openSalvagePanel(0x80000004);
  assert.ok(isOpen("hb-salvage-panel"));
  const t = text("hb-salvage-panel");
  assert.match(t, /WARNING: Items in this panel will be destroyed!/);
  assert.match(t, /Using: Ust/);
  assert.doesNotMatch(t, HEX);
});
await check("confirmed salvage sends createTinkeringTool(tool, Uint32Array) and flushes the list", () => {
  calls.length = 0;
  salvage.addItem(0x80000002, "Iron Dagger");
  let request = null;
  window.addEventListener("hb:salvage-confirm-request", (ev) => { request = ev.detail; });
  findButton(byId("hb-salvage-panel"), "Salvage").click();
  assert.ok(request, "confirm requested");
  assert.equal(request.toolLabel, "Ust");
  window.dispatchEvent(new FakeCustomEvent("hb:salvage-confirm-result", {
    detail: { kind: "confirm", toolGuid: request.toolGuid, items: request.items },
  }));
  assert.deepEqual(calls[0], ["createTinkeringTool", 0x80000004, [0x80000002], "Uint32Array"]);
  assert.match(text("hb-salvage-panel"), /Drag items from your pack here/);
  assert.ok(isOpen("hb-salvage-panel"), "stays open for the next batch (gmSalvageUI::Salvage)");
});
await check("drops: equipped item refused; a pack adds its contents (gmSalvageUI::_AddContainedItems)", () => {
  inv.push(
    { guid: 0x80000020, wcid: 200, name: "Sack", value: 5, stackSize: 1, itemType: 0x200, iconId: 0, equipMask: 0, containerId: PLAYER },
    { guid: 0x80000021, wcid: 201, name: "Bronze Axe", value: 60, stackSize: 1, itemType: 0x01, iconId: 0, equipMask: 0, containerId: 0x80000020 },
    { guid: 0x80000022, wcid: 202, name: "Copper Ring", value: 40, stackSize: 1, itemType: 0x08, iconId: 0, equipMask: 0, containerId: 0x80000020 },
  );
  const well = byId("hb-salvage-panel").querySelector(".hsv-well");
  const drop = (guid) => well.dispatchEvent(new FakeEvent("drop", {
    dataTransfer: { types: ["application/x-hb-inv-guid"], getData: () => String(guid) },
  }));
  drop(0x80000003); // equipped robe
  assert.doesNotMatch(well.textContent, /Worn Robe/, "not staged");
  assert.match(text("hb-salvage-panel"), /Unequip Worn Robe before salvaging it/, "told why");
  drop(0x80000020); // the sack
  const t = text("hb-salvage-panel");
  assert.match(t, /Bronze Axe/);
  assert.match(t, /Copper Ring/);
  assert.match(t, /2 items/);
  assert.match(t, /Not yet appraised/);
  findButton(byId("hb-salvage-panel"), "Clear List").click();
  assert.match(text("hb-salvage-panel"), /Nothing to salvage/);
});
await check("SalvageOperationsResult lands in the Results section", () => {
  bus.emit("salvageResult", { skill: 100, augBonus: 0, results: [{ material: 0x3D, units: 12, workmanship: 5.42 }] });
  assert.match(text("hb-salvage-panel"), /You obtain 12 × Iron \(workmanship 5\.42\)/);
});

/* ── [4] tinker ───────────────────────────────────────────────────────── */
console.log("[tinker]");
tinker.mount({ client: { events: bus } });
await check("two named slots; Apply sends useWithTarget(tool, target)", () => {
  calls.length = 0;
  window.__openTinkerPanel({ toolGuid: 0x80000004, targetGuid: 0x80000002 });
  const t = text("hb-tinker-panel");
  assert.match(t, /Ust/);
  assert.match(t, /Iron Dagger/);
  assert.doesNotMatch(t, HEX);
  findButton(byId("hb-tinker-panel"), "Apply").click();
  assert.deepEqual(calls.find((c) => c[0] === "useWithTarget"), ["useWithTarget", 0x80000004, 0x80000002]);
});

/* ── [5] book ─────────────────────────────────────────────────────────── */
console.log("[book]");
await check("opens on bookUpdated with the book's NAME, author and page 1 of 2", () => {
  bus.emit("bookUpdated", {});
  assert.ok(isOpen("hb-book-panel"));
  const t = text("hb-book-panel");
  assert.match(t, /Tome of Lore/);
  assert.match(t, /by Gaerlan/);
  assert.match(t, /The first page\./);
  assert.match(t, /Page 1 of 2/);
  assert.doesNotMatch(t, HEX);
});
await check("next page turns; Edit → Save sends bookModifyPage(guid, page, false, text)", () => {
  calls.length = 0;
  byId("hb-book-panel").querySelector(".hbo-next").click();
  assert.match(text("hb-book-panel"), /The second page\./);
  findButton(byId("hb-book-panel"), "Edit").click();
  const ta = byId("hb-book-panel").querySelector(".hbo-edit");
  ta.value = "Rewritten.";
  findButton(byId("hb-book-panel"), "Save").click();
  assert.deepEqual(calls[0], ["bookModifyPage", 0x80000010, 1, false, "Rewritten."]);
});

await check("Inscribe → Save sends setInscription; Esc while editing cancels instead of closing", () => {
  calls.length = 0;
  const root = byId("hb-book-panel");
  findButton(root, "Inscribe").click();
  assert.match(text("hb-book-panel"), /Inscription/);
  const ta = root.querySelector(".hbo-edit");
  ta.value = "To my friend";
  findButton(root, "Save").click();
  assert.deepEqual(calls[0], ["setInscription", 0x80000010, "To my friend"]);
  findButton(root, "Edit").click();
  cw.topCommerceWindow; // window stack is shared
  const esc = Object.assign(new FakeEvent("keydown"), {
    key: "Escape", code: "Escape", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
  });
  ta.dispatchEvent(esc); // focus is in the book's textarea
  assert.ok(isOpen("hb-book-panel"), "first Esc only cancels the edit");
  assert.ok(findButton(root, "Edit"), "back to read mode");
});

/* ── [6] house ────────────────────────────────────────────────────────── */
console.log("[house]");
await check("House tab shows status, dwelling, map location and maintenance — no hex landblock", () => {
  window.__openHousePanel();
  assert.ok(isOpen("hb-house-panel"));
  const t = text("hb-house-panel");
  assert.match(t, /You own a house/);
  assert.match(t, /Cottage/);
  assert.match(t, /42\.2N, 33\.6E/);
  assert.match(t, /Due in 6d/);
  assert.doesNotMatch(t, HEX);
  findButton(byId("hb-house-panel"), "Query House").click();
  assert.deepEqual(calls.at(-1), ["houseQuery"]);
});

await check("a new HouseProfile (covenant crystal used) opens the Buy tab with the crystal filled in", async () => {
  window.__closeHousePanel();
  assert.equal(isOpen("hb-house-panel"), false);
  // The watcher's FIRST look only records a baseline (no auto-open on
  // login) — let it see the no-profile state, then "use the crystal".
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(isOpen("hb-house-panel"), false, "no auto-open without a profile change");
  handle.playerHouseProfile = () => ({
    dwellingId: 77, crystalGuid: 0x60000001, ownerId: 0, ownerName: "", houseType: 2,
    maintenanceFree: false, bitmask: 0, free() {},
  });
  await new Promise((r) => setTimeout(r, 1100)); // next 1 Hz tick
  assert.ok(isOpen("hb-house-panel"), "auto-opened");
  const t = text("hb-house-panel");
  assert.match(t, /Covenant Crystal/);
  assert.match(t, /Villa/);
  assert.match(t, /For sale/);
  assert.match(t, /Drop payment items here/);
  const page = byId("hb-house-panel").querySelectorAll(".hhp-page").find((p) => p.dataset.page === "buy");
  assert.equal(page.hidden, false, "Buy tab is showing");
});

/* ── [7] Esc closes the topmost window only ───────────────────────────── */
console.log("[window stack]");
await check("Esc closes only the topmost open window", () => {
  const before = ["hb-vendor-bar", "hb-trade-panel", "hb-salvage-panel", "hb-tinker-panel", "hb-book-panel", "hb-house-panel"]
    .filter(isOpen);
  assert.ok(before.length >= 5, `expected most windows open, got ${before.join(",")}`);
  const top = cw.topCommerceWindow();
  assert.equal(top.root.id, "hb-house-panel", "the last opened is on top");
  document.dispatchEvent(Object.assign(new FakeEvent("keydown"), {
    key: "Escape", code: "Escape", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
  }));
  assert.equal(isOpen("hb-house-panel"), false, "topmost closed");
  for (const id of before.filter((i) => i !== "hb-house-panel")) assert.ok(isOpen(id), `${id} stayed open`);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
