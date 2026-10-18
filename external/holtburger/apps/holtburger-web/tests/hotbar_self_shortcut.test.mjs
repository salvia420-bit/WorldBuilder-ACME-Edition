// tests/hotbar_self_shortcut.test.mjs — usetarget-2/-4 (2026-10-18).
//
// Owner: "if you had a healing kit in hotkey 2 and your main inventory pack in
// hotkey 1, if you pressed 2 and then 1, you would heal yourself."
//
// Retail: the main pack slot's UIItem is the PLAYER (gmInventoryUI::
// RecvNotice_SetDisplayInventory, acclient.c:222199). Dropped on the toolbar,
// gmToolbarUI::HandleDropRelease (:241141) → CreateShortcutToItem (:240523)
// accepts it (IsShortcutEligible :239885 excepts the player; IsOwnedByObject
// :437709 is true for the player itself) → Event_AddShortCut(index, player).
// ACE saves (index, objectId) unvalidated (Player_Character.cs
// HandleActionAddShortcut) and PlayerDescription returns it. The player's
// icon is the main pack's (IconData::RenderIcons :437953: IsThePlayer →
// UI-asset 0x10000004 as a Container). gmToolbarUI::UseShortcut (:239995)
// tests the target mode first: with a use-on-target armed the slot's object is
// the target (ExecuteTargetModeForItem → TargetAcquired); otherwise
// UseObject(player) opens the main pack.
//
// CONTRACT
//   [1] pure: decideFireAction → "useTarget" for an item while a target is
//       awaited (spells unchanged); staleBindingAction keeps the self binding;
//       selfShortcutDropGuid takes only the local player's guid;
//   [2] mount (REAL plugins/hotbar.js): a slot accepts the main pack drag,
//       binds {itemGuid: player}, sends AddShortcut(i, player, 0), saves it
//       per character and draws the main-pack icon (0x0600127E as Container);
//       a foreign self drag is ignored;
//   [3] firing: kit pending → the self slot resolves the target on the
//       player (an item slot on its item); otherwise the self slot is
//       activateItem(player) and never a bare Use of yourself;
//   [4] relog: the server list restores the self binding and the stale-item
//       prune keeps it (while it clears a vanished item); with no character
//       known the prune clears nothing (no RemoveShortCut);
//   [5] a self shortcut drawn before the player guid was known (drawn as an
//       item) is redrawn with the main-pack icon on the next inventory change;
//   [6] `?shortcutTargetMode=off`: a press activates the item even in target
//       mode (the old press).
//
// Run from apps/holtburger-web/:  node tests/hotbar_self_shortcut.test.mjs

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// ─── fake DOM (after tests/hotbar_per_character.test.mjs) ─────────────
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
  focus() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  addEventListener(type, fn, opt) { this.listeners.push({ type, fn, capture: opt === true || !!opt?.capture }); }
  removeEventListener(type, fn, opt) {
    const capture = opt === true || !!opt?.capture;
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
  // Target-only dispatch (the slot listeners under test sit on the slot).
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (const l of [...this.listeners]) if (l.type === ev.type) l.fn.call(this, ev);
    return !ev.defaultPrevented;
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
    const val = name.startsWith("data-")
      ? el.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
      : el.attrs[name];
    if (val === undefined) return false;
    if (m[2] !== undefined && String(val) !== m[2]) return false;
  }
  return true;
}
const document = {
  listeners: [],
  createElement: (t) => new FakeEl(t),
  createTextNode: (t) => { const n = new FakeEl("#text"); n._text = String(t); return n; },
  getElementById(id) {
    const walk = (n) => { for (const c of n.children) { if (c.id === id) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(this.body) || walk(this.head);
  },
  querySelector(sel) { return this.body.querySelector(sel) || this.head.querySelector(sel); },
  querySelectorAll(sel) { return [...this.head.querySelectorAll(sel), ...this.body.querySelectorAll(sel)]; },
  addEventListener(type, fn) { this.listeners.push({ type, fn }); },
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn)); },
  dispatchEvent(ev) { for (const l of [...this.listeners]) if (l.type === ev.type) l.fn(ev); return true; },
};
docRef = document;
document.head = new FakeEl("head");
document.body = new FakeEl("body");
document.documentElement = new FakeEl("html");
globalThis.document = document;
globalThis.window = globalThis;
globalThis.innerWidth = 1600;
globalThis.innerHeight = 900;
globalThis.location = { search: "" };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = (el) => ({ backgroundImage: el.style.backgroundImage || "none", position: "static", paddingLeft: "0", paddingRight: "0" });
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

const busHandlers = new Map();
window.__pluginClient = {
  events: {
    on(t, fn) { if (!busHandlers.has(t)) busHandlers.set(t, new Set()); busHandlers.get(t).add(fn); },
    off(t, fn) { busHandlers.get(t)?.delete(fn); },
    emit(t, d) { for (const fn of busHandlers.get(t) || []) fn(d); },
  },
};
window.__mainPanel = { toggleView() {}, isOpen: () => false, currentViewId: () => null };
window.liveScene3d = { entityManager: { getSelectedTarget: () => 0, entityMap: new Map() } };
window.__getCurrentStanceLow = () => 0x3D;
// The icon layers the slots ask the wasm for (a miss: the slot stays blank).
const iconsAsked = [];
window.__hbWasm = { fetch_icon_pixels: (id) => { iconsAsked.push(id >>> 0); return null; } };

const SERVER = "127.0.0.1:9000";
const ACCOUNT = "tailnet1";
const ME = 0x50000001;
const OTHER_PLAYER = 0x50000002;
const KIT = 0x7000AA01;
const GONE = 0x7000AA09;
const SELF_MIME = "application/x-hb-self-guid";
window.__hbLoginKey = { server: SERVER, account: ACCOUNT };
window.getLocalPlayerGuid = () => ME;

const calls = [];
let serverList = [];
const handle = {
  playerGuid: () => ME,
  setCombatMode() {},
  playerInventory: () => [{ guid: KIT, wcid: 628, name: "Handy Healing Kit", itemType: 0x80, free() {} }],
  useObject: (g) => calls.push(["useObject", g >>> 0]),
  objectName: (g) => ((g >>> 0) === ME ? "Tester" : undefined),
  objectHealthFraction: () => -1,
  queryHealth() {},
  getSpellRecord: () => new Map(),
  addShortcut: (...a) => calls.push(["addShortcut", ...a]),
  removeShortcut: (...a) => calls.push(["removeShortcut", ...a]),
  playerShortcuts: () => new Uint32Array(serverList),
  playerStats: () => ({ attributes: new Uint32Array([1, 10, 10, 0]), free() {} }),
  combatMode: () => 1,
};
window.__sessionHandle = handle;
const activated = [];
let activateResult = true;
window.__inventory = { activateItem: (g) => { activated.push(g >>> 0); return activateResult; }, setArmedItem() {} };

const hotbarUrl = pathToFileURL(resolvePath(APP, "plugins/hotbar.js")).href;
const hotbar = await import(hotbarUrl);
const { decideFireAction, staleBindingAction, selfShortcutDropGuid, SELF_SHORTCUT_ICON, hotbarStorageKey } = hotbar;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  [PASS] ${name}`); }
  catch (e) { fail += 1; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
function ok(c, label) { if (!c) throw new Error(label); }
function eq(a, b, label = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${label} expected ${y}, got ${x}`); }
const tick = () => new Promise((r) => setTimeout(r, 0));
const ev = (type, init = {}) => ({ type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init });
function makeDT(map) {
  const data = new Map(Object.entries(map));
  return { types: [...data.keys()], dropEffect: "", effectAllowed: "all", getData: (t) => data.get(t) ?? "", setData() {}, setDragImage() {} };
}
const slotEl = (i) => document.querySelectorAll(".hb-hotbar-slot").find((s) => s.dataset.slot === String(i));
function dropOn(i, dt) {
  const el = slotEl(i);
  const over = ev("dragover", { dataTransfer: dt });
  el.dispatchEvent(over);
  el.dispatchEvent(ev("drop", { dataTransfer: dt }));
  return over.defaultPrevented;
}
const press = (i) => slotEl(i).dispatchEvent(ev("click"));

console.log("[1] pure helpers");
await check("decideFireAction: an item slot while a target is awaited → useTarget; otherwise activateItem", () => {
  eq(decideFireAction({ itemGuid: ME }, { isSelfTargeted: true, softTargetGuid: 0, useTargetPending: true }), { kind: "useTarget", itemGuid: ME });
  eq(decideFireAction({ itemGuid: KIT }, { isSelfTargeted: true, softTargetGuid: 0, useTargetPending: true }), { kind: "useTarget", itemGuid: KIT });
  eq(decideFireAction({ itemGuid: ME }, { isSelfTargeted: true, softTargetGuid: 0 }), { kind: "activateItem", itemGuid: ME });
});
await check("decideFireAction: spell slots ignore the target mode (castSelf / castOnTarget / needTarget)", () => {
  eq(decideFireAction({ spellId: 7 }, { isSelfTargeted: true, softTargetGuid: 0, useTargetPending: true }), { kind: "castSelf", spellId: 7 });
  eq(decideFireAction({ spellId: 7 }, { isSelfTargeted: false, softTargetGuid: 5, useTargetPending: true }), { kind: "castOnTarget", spellId: 7, targetGuid: 5 });
  eq(decideFireAction({ spellId: 7 }, { isSelfTargeted: false, softTargetGuid: 0, useTargetPending: true }), { kind: "needTarget", spellId: 7 });
});
await check("staleBindingAction: the self shortcut is kept even past the grace; others as before", () => {
  const inv = new Set([KIT]);
  eq(staleBindingAction({ itemGuid: ME }, inv, new Set([KIT]), true, ME), "keep");
  eq(staleBindingAction({ itemGuid: ME }, inv, new Set([KIT]), true), "clear", "no selfGuid → the old rule");
  eq(staleBindingAction({ itemGuid: GONE }, inv, new Set([KIT]), true, ME), "clear");
  eq(staleBindingAction({ itemGuid: KIT }, inv, new Set([KIT]), true, ME), "keep");
});
await check("selfShortcutDropGuid: only the local player's guid; anything else → 0", () => {
  eq(selfShortcutDropGuid(makeDT({ [SELF_MIME]: String(ME) }), ME), ME);
  eq(selfShortcutDropGuid(makeDT({ [SELF_MIME]: String(OTHER_PLAYER) }), ME), 0, "another player");
  eq(selfShortcutDropGuid(makeDT({ [SELF_MIME]: String(ME) }), 0), 0, "not logged in");
  eq(selfShortcutDropGuid(makeDT({}), ME), 0, "no self MIME");
  eq(selfShortcutDropGuid(null, ME), 0);
  eq(SELF_SHORTCUT_ICON, { iconId: 0x0600127E, itemType: 0x200 });
});

console.log("\n[2] mount — drag the main pack onto shortcut 1");
let dispose = hotbar.mount({ client: window.__pluginClient });
const kMe = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: ME });
await check("the slot accepts the self drag and binds the player; AddShortcut(0, player, 0) goes out", async () => {
  calls.length = 0;
  iconsAsked.length = 0;
  const accepted = dropOn(0, makeDT({ [SELF_MIME]: String(ME), "text/plain": "Tester" }));
  ok(accepted, "dragover accepted");
  eq(window.__hotbar.getSlot(0), { itemGuid: ME });
  eq(calls.filter((c) => c[0] === "addShortcut"), [["addShortcut", 0, ME, 0, 0]]);
  eq(JSON.parse(localStorage.getItem(kMe)).slots[0], { itemGuid: ME }, "saved under this character");
  await tick(); await tick();
  ok(iconsAsked.includes(0x0600127E), `the main-pack icon was asked for (asked ${iconsAsked.map((i) => i.toString(16))})`);
});
await check("a self drag carrying another guid is ignored", () => {
  calls.length = 0;
  dropOn(2, makeDT({ [SELF_MIME]: String(OTHER_PLAYER) }));
  eq(window.__hotbar.getSlot(2), null);
  eq(calls.length, 0);
});
await check("the kit binds to shortcut 2 as an ordinary item", () => {
  dropOn(1, makeDT({ "application/x-hb-inv-guid": String(KIT) }));
  eq(window.__hotbar.getSlot(1), { itemGuid: KIT });
});

console.log("\n[3] firing: 2 then 1");
await check("no target mode: the self slot is activateItem(player) (opens the main pack), no bare Use", () => {
  calls.length = 0;
  activated.length = 0;
  delete window.__useTargeting;
  press(0);
  eq(activated, [ME]);
  eq(calls.filter((c) => c[0] === "useObject"), []);
  activateResult = false; // e.g. `?hotbarActivate=off`
  press(0);
  eq(calls.filter((c) => c[0] === "useObject"), [], "never a Use of yourself");
  activateResult = true;
});
await check("kit pending (pressed 2) → pressing 1 targets yourself: __useTargeting.resolve(player)", () => {
  const resolved = [];
  window.__useTargeting = { pending: { itemGuid: KIT, itemName: "Handy Healing Kit" }, resolve(g) { resolved.push(g); this.pending = null; return true; } };
  activated.length = 0;
  press(0);
  eq(resolved, [ME]);
  eq(activated, [], "not used");
  window.__useTargeting.pending = { itemGuid: KIT, itemName: "Handy Healing Kit" };
  press(1);
  eq(resolved, [ME, KIT], "an item shortcut targets its item (retail UseShortcut)");
  delete window.__useTargeting;
});

console.log("\n[4] relog: the server list restores it, the prune keeps it");
dispose();
store.clear();
serverList = [0, ME, 0, 4, GONE, 0];
dispose = hotbar.mount({ client: window.__pluginClient });
await check("PlayerDescription's (0, player) restores the self shortcut", () => {
  window.__pluginClient.events.emit("playerStatsUpdated", {});
  eq(window.__hotbar.getSlot(0), { itemGuid: ME, wcid: 0 });
  eq(window.__hotbar.getSlot(4), { itemGuid: GONE, wcid: 0 });
});
await check("no character known (between sessions) → the sweep prunes nothing, no RemoveShortCut", () => {
  const realNow = Date.now;
  const realGet = window.getLocalPlayerGuid;
  const realPg = handle.playerGuid;
  Date.now = () => realNow() + 60_000;
  window.getLocalPlayerGuid = () => 0;
  handle.playerGuid = () => 0;
  try {
    calls.length = 0;
    window.__pluginClient.events.emit("playerInventoryChanged", {});
  } finally {
    Date.now = realNow;
    window.getLocalPlayerGuid = realGet;
    handle.playerGuid = realPg;
  }
  eq(window.__hotbar.getSlot(0), { itemGuid: ME, wcid: 0 }, "self kept");
  eq(window.__hotbar.getSlot(4), { itemGuid: GONE, wcid: 0 }, "nothing is pruned without the character");
  eq(calls.filter((c) => c[0] === "removeShortcut"), []);
});
await check("past the never-seen grace the prune clears the vanished item and keeps yourself", () => {
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  try {
    calls.length = 0;
    window.__pluginClient.events.emit("playerInventoryChanged", {});
  } finally { Date.now = realNow; }
  eq(window.__hotbar.getSlot(4), null, "vanished item cleared");
  eq(window.__hotbar.getSlot(0), { itemGuid: ME, wcid: 0 }, "self kept");
  eq(calls.filter((c) => c[0] === "removeShortcut"), [["removeShortcut", 4]]);
});
dispose();
serverList = [];

console.log("\n[5] a self shortcut drawn before the player guid is known is redrawn");
// Worst case: the bar draws from the browser-wide cache (`?hotbarPerChar=off`)
// while the wasm already knows the player's entity but neither guid getter is
// ready — the slot is drawn as an ITEM: the player's own icon, 0x06001036.
const { resetIconCache } = await import(pathToFileURL(resolvePath(APP, "ui/ac_icon_cache.js")).href);
const slotIcon = (i) => slotEl(i).querySelector(".hb-hotbar-slot-icon");
const settle = async () => { for (let k = 0; k < 8; k++) await tick(); };
{
  store.clear();
  resetIconCache();
  iconsAsked.length = 0;
  window.__hbWasm = { fetch_icon_pixels: (id) => { iconsAsked.push(id >>> 0); return { width: 32, height: 32, pixels: new Uint8Array(32 * 32 * 4) }; } };
  const realGet = window.getLocalPlayerGuid;
  const realPg = handle.playerGuid;
  window.getLocalPlayerGuid = () => 0;
  handle.playerGuid = () => 0;
  handle.getObjectIconId = (g) => ((g >>> 0) === ME ? 0x06001036 : 0);
  location.search = "?hotbarPerChar=off";
  localStorage.setItem("holtburger_hotbar_v1", JSON.stringify({ slots: [{ itemGuid: ME }] }));
  dispose = hotbar.mount({ client: window.__pluginClient });
  await settle();
  await check("drawn with the guid unknown → the item path (the player's own icon)", () => {
    eq(slotIcon(0).dataset.self, "0");
    ok(iconsAsked.includes(0x06001036), "the player's icon was asked for");
    ok(!iconsAsked.includes(0x0600127E), "not yet the main-pack icon");
  });
  window.getLocalPlayerGuid = realGet;
  handle.playerGuid = realPg;
  await check("once the guid is known the next inventory change redraws it with the main-pack icon", async () => {
    iconsAsked.length = 0;
    window.__pluginClient.events.emit("playerInventoryChanged", {});
    await settle();
    eq(slotIcon(0).dataset.self, "1");
    eq(slotIcon(0).dataset.boundKey, `self:${ME}`);
    ok(iconsAsked.includes(0x0600127E), `the main-pack icon was asked for (asked ${iconsAsked.map((i) => i.toString(16))})`);
    ok(/^url\("data:image\/png;base64,/.test(slotIcon(0).style.backgroundImage), "an icon is drawn");
  });
  dispose();
  delete handle.getObjectIconId;
  location.search = "";
  store.clear();
}

console.log("\n[6] ?shortcutTargetMode=off");
location.search = "?shortcutTargetMode=off";
const hotbarOff = await import(hotbarUrl + "?shortcutTargetMode=off");
store.clear();
dispose = hotbarOff.mount({ client: window.__pluginClient });
await check("a press activates the item even while a target is awaited", () => {
  window.__hotbar.bindItemToSlot(0, ME);
  const resolved = [];
  window.__useTargeting = { pending: { itemGuid: KIT }, resolve(g) { resolved.push(g); return true; } };
  activated.length = 0;
  press(0);
  eq(resolved, []);
  eq(activated, [ME]);
  delete window.__useTargeting;
});
dispose();
location.search = "";

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
