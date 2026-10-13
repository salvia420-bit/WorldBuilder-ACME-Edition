// tests/hotbar_per_character.test.mjs — inventory-session-3 (2026-10-13).
//
// The hotbar cached its bindings under ONE browser-wide localStorage key
// (`holtburger_hotbar_v1`), loaded at mount and merged with the server list
// only once that list was non-empty. After /logout → another character in the
// same tab, the last character's items came back on the new bar (pressing 1
// used the old character's guid), and its spell bindings stayed for good.
// Retail gmToolbarUI::UpdateFromPlayerDesc (acclient.c:241958) flushes all 18
// slots and rebuilds them from the new character's PlayerModule; ACE stores
// only (index, objectId) per shortcut, so spell bindings live only in the
// client cache.
//
// CONTRACT
//   [1] hotbarStorageKey: one key per server + account + character
//       (case-insensitive server/account, as lastLocationKey); null with no
//       character;
//   [2] reconcileSlots: an empty server list with PlayerDescription landed
//       flushes the cached item bindings and keeps the cached spells; with no
//       PlayerDescription nothing changes (null); a non-empty server list wins
//       per slot (items stamped with their wcid);
//   [3] loadCharacterHotbar: the old browser-wide cache migrates once, to the
//       first character loaded, and no other;
//   [4] playerDescriptionLanded / hotbarPerCharEnabled;
//   [5] mount (REAL plugins/hotbar.js on a fake DOM): nothing is loaded before
//       the character is known; PlayerDescription (a playerStatsUpdated with
//       attributes) loads THIS character's cache and flushes its stale items;
//       the mount event and the window.__hotbar API (addonSlot) are unchanged;
//       `?hotbarPerChar=off` restores the browser-wide cache read at mount.
//
// Run from apps/holtburger-web/:  node tests/hotbar_per_character.test.mjs

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const APP = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// ─── fake DOM (after test_toolbar_mount_smoke.mjs) ────────────────────
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
  getBoundingClientRect() {
    const w = parseFloat(this.style.width) || 0;
    const h = parseFloat(this.style.height) || 0;
    const l = parseFloat(this.style.left) || 0;
    const t = parseFloat(this.style.top) || 0;
    return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t };
  }
  focus() {}
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
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      val = el.dataset[key];
    } else {
      val = el.attrs[name];
    }
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
globalThis.getComputedStyle = (el) => ({ backgroundImage: el.style.backgroundImage || "none", position: el.style.position || "static", paddingLeft: "0", paddingRight: "0" });
function makeStorage() {
  return {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
}
globalThis.localStorage = makeStorage();
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

// Plugin bus: index.html builds it after login; the bar mounts at page load.
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

const hotbar = await import(pathToFileURL(resolvePath(APP, "plugins/hotbar.js")).href);
const {
  hotbarStorageKey, reconcileSlots, loadCharacterHotbar, playerDescriptionLanded, hotbarPerCharEnabled,
} = hotbar;

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  [PASS] ${name}`); }
  catch (e) { fail += 1; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
function ok(c, label) { if (!c) throw new Error(label); }
function eq(a, b, label = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${label} expected ${y}, got ${x}`); }

const LEGACY = "holtburger_hotbar_v1";
const SERVER = "127.0.0.1:9000";
const ACCOUNT = "tailnet1";
const CHAR_A = 0x50000001;
const CHAR_B = 0x50000002;
const CHAR_C = 0x50000003;
const ITEM_A1 = 0x7000AA01;
const ITEM_A2 = 0x7000AA02;
const ITEM_B = 0x7000BB01;
const ITEM_B_STALE = 0x7000BB02;
const SPELL_A = 27;
const SPELL_B = 1234;
const slots18 = (m = {}) => Array.from({ length: 18 }, (_, i) => (i in m ? m[i] : null));
const triple = (idx, guid, spell = 0, layer = 0) => [idx, guid, ((layer << 16) | spell) >>> 0];

console.log("[1] hotbarStorageKey");
check("different characters → different keys; same character → same key", () => {
  const a = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_A });
  const b = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_B });
  ok(a && b && a !== b, `${a} vs ${b}`);
  eq(hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_A }), a, "stable");
  ok(a.startsWith(`${LEGACY}|`), a);
  ok(a !== LEGACY, "not the browser-wide key");
});
check("server/account case-insensitive (as lastLocationKey); a different account → a different key", () => {
  const a = hotbarStorageKey({ server: "Play.Example:9000", account: "Tailnet1", charId: CHAR_A });
  eq(hotbarStorageKey({ server: "play.example:9000", account: "tailnet1", charId: CHAR_A }), a);
  ok(hotbarStorageKey({ server: "play.example:9000", account: "other", charId: CHAR_A }) !== a, "account");
});
check("no character → null (nothing is read or written)", () => {
  eq(hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: 0 }), null);
  eq(hotbarStorageKey({ server: SERVER, account: ACCOUNT }), null);
  eq(hotbarStorageKey(), null);
});

console.log("\n[2] reconcileSlots (retail gmToolbarUI::UpdateFromPlayerDesc)");
check("empty server list + PlayerDescription landed → cached items flushed, cached spells kept", () => {
  const cached = slots18({ 0: { itemGuid: ITEM_A1, wcid: 5 }, 1: { spellId: SPELL_A }, 2: { itemGuid: ITEM_A2 } });
  const out = reconcileSlots([], cached, { pdReceived: true });
  eq(out, slots18({ 1: { spellId: SPELL_A } }));
});
check("empty server list, no PlayerDescription yet → null (nothing changes)", () => {
  const cached = slots18({ 0: { itemGuid: ITEM_A1 }, 1: { spellId: SPELL_A } });
  const before = JSON.stringify(cached);
  eq(reconcileSlots([], cached, { pdReceived: false }), null, "[]");
  eq(reconcileSlots(null, cached, { pdReceived: false }), null, "null");
  eq(reconcileSlots(new Uint32Array(0), cached), null, "Uint32Array(0), default");
  eq(JSON.stringify(cached), before, "cache untouched");
});
check("non-empty server list wins per slot; cached spells only fill empty server slots; wcid stamped", () => {
  const cached = slots18({
    0: { spellId: SPELL_A },          // server has an item here → server wins
    1: { itemGuid: ITEM_A1 },         // not on the server → flushed
    2: { spellId: SPELL_B },          // server slot empty → kept
    17: { itemGuid: ITEM_B_STALE },   // not on the server → flushed
  });
  const flat = new Uint32Array([...triple(0, ITEM_B), ...triple(5, 0, 99, 1), ...triple(40, ITEM_A2)]);
  const wcidOf = (g) => (g === ITEM_B ? 777 : 0);
  for (const pd of [false, true]) {
    eq(reconcileSlots(flat, cached, { pdReceived: pd, wcidOf }), slots18({
      0: { itemGuid: ITEM_B, wcid: 777 },
      2: { spellId: SPELL_B },
      5: { spellId: 99 },
    }), `pdReceived=${pd}`);
  }
});
check("a throwing wcid lookup degrades to wcid 0", () => {
  const out = reconcileSlots([...triple(3, ITEM_B)], slots18(), { pdReceived: true, wcidOf: () => { throw new Error("x"); } });
  eq(out[3], { itemGuid: ITEM_B, wcid: 0 });
});

console.log("\n[3] loadCharacterHotbar — one-time legacy migration");
check("the browser-wide cache migrates to the FIRST character loaded, once", () => {
  const st = makeStorage();
  const legacy = { slots: slots18({ 0: { itemGuid: ITEM_A1 }, 4: { spellId: SPELL_A } }) };
  st.setItem(LEGACY, JSON.stringify(legacy));
  const kA = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_A });
  const kB = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_B });
  const a = loadCharacterHotbar(st, kA);
  eq(a.slots, legacy.slots, "first character gets the old cache");
  eq(JSON.parse(st.getItem(kA)).slots, legacy.slots, "copied to its own key at once");
  const b = loadCharacterHotbar(st, kB);
  eq(b.slots, slots18(), "second character starts empty");
  eq(st.getItem(kB), null, "nothing written for it");
  ok(st.getItem(LEGACY) != null, "the old key stays for ?hotbarPerChar=off");
});
check("a character with its own cache reads it (no migration)", () => {
  const st = makeStorage();
  st.setItem(LEGACY, JSON.stringify({ slots: slots18({ 0: { itemGuid: ITEM_A1 } }) }));
  const kB = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_B });
  st.setItem(kB, JSON.stringify({ slots: slots18({ 3: { spellId: SPELL_B } }) }));
  eq(loadCharacterHotbar(st, kB).slots, slots18({ 3: { spellId: SPELL_B } }));
});
check("9-slot saves pad to 18; junk / no storage / no key → empty", () => {
  const st = makeStorage();
  const k = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_C });
  st.setItem(k, JSON.stringify({ slots: [{ spellId: 1 }, null, null, null, null, null, null, null, null] }));
  const s = loadCharacterHotbar(st, k).slots;
  eq(s.length, 18, "padded");
  eq(s[0], { spellId: 1 });
  st.setItem(k, "{not json");
  eq(loadCharacterHotbar(st, k).slots, slots18(), "junk");
  eq(loadCharacterHotbar(null, k).slots, slots18(), "no storage");
  eq(loadCharacterHotbar(st, null).slots, slots18(), "no key");
});

console.log("\n[4] playerDescriptionLanded / hotbarPerCharEnabled");
check("attributes in playerStats() ⇔ PlayerDescription landed; the snapshot is freed", () => {
  let freed = 0;
  const snap = (attrs) => ({ attributes: attrs, free() { freed++; } });
  eq(playerDescriptionLanded({ playerStats: () => snap(new Uint32Array([1, 10, 10, 0])) }), true, "attributes");
  eq(playerDescriptionLanded({ playerStats: () => snap(new Uint32Array(0)) }), false, "empty snapshot");
  eq(freed, 2, "free()");
  eq(playerDescriptionLanded({ playerStats: () => { throw new Error("x"); } }), false, "throws");
  eq(playerDescriptionLanded({}), false, "old pkg");
  eq(playerDescriptionLanded(null), false, "no handle");
});
check("?hotbarPerChar default ON; off/0/false disable", () => {
  eq(hotbarPerCharEnabled(""), true);
  eq(hotbarPerCharEnabled("?hotbarPerChar=on"), true);
  for (const v of ["off", "0", "false"]) eq(hotbarPerCharEnabled(`?hotbarPerChar=${v}`), false, v);
});

console.log("\n[5] mount — the failure scenario (A leaves, B with no shortcuts enters)");
// The browser-wide cache holds character A's bar (pre-fix saves); B has its
// own per-character cache with a spell and an item it no longer has on the
// server.
const kA = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_A });
const kB = hotbarStorageKey({ server: SERVER, account: ACCOUNT, charId: CHAR_B });
function seedStorage() {
  globalThis.localStorage = makeStorage();
  localStorage.setItem(LEGACY, JSON.stringify({
    slots: slots18({ 0: { itemGuid: ITEM_A1 }, 1: { itemGuid: ITEM_A2 }, 2: { spellId: SPELL_A } }),
  }));
  localStorage.setItem(kB, JSON.stringify({
    slots: slots18({ 4: { spellId: SPELL_B }, 5: { itemGuid: ITEM_B_STALE } }),
  }));
}
const calls = [];
let pdLanded = false;
let serverList = [];
function makeHandle(guid) {
  return {
    playerGuid: () => guid,
    setCombatMode() {},
    playerInventory: () => [],
    useObject: (g) => calls.push(["useObject", g]),
    objectName: () => undefined,
    objectHealthFraction: () => -1,
    queryHealth() {},
    getSpellRecord: () => new Map(),
    addShortcut: (...a) => calls.push(["addShortcut", ...a]),
    removeShortcut: (...a) => calls.push(["removeShortcut", ...a]),
    playerShortcuts: () => new Uint32Array(serverList),
    playerStats: () => ({ attributes: new Uint32Array(pdLanded ? [1, 10, 10, 0] : []), free() {} }),
    combatMode: () => 1,
  };
}
const statsHandlers = () => busHandlers.get("playerStatsUpdated")?.size ?? 0;
const mountedEvents = [];
document.addEventListener("hb-hotbar-mounted", (ev) => mountedEvents.push(ev.detail));
const slotsNow = () => Array.from({ length: 18 }, (_, i) => window.__hotbar.getSlot(i));

seedStorage();
delete window.__sessionHandle;
delete window.__hbLoginKey;
let dispose = hotbar.mount({ client: window.__pluginClient });
// target-bar's toolbar controls (mounted by the hotbar) listen too; the
// hotbar's own reconcile listener is the one extra.
const statsAtMount = statsHandlers();
check("page-load mount: the bar, its mount event and the window.__hotbar API are unchanged", () => {
  ok(document.getElementById("hb-hotbar"), "#hb-hotbar");
  eq(mountedEvents.length, 1, "one hb-hotbar-mounted");
  ok(mountedEvents[0]?.addons && mountedEvents[0].addons === window.__hotbar.addonSlot(), "detail.addons = addonSlot()");
  eq(Object.keys(window.__hotbar).sort(), [
    "addonSlot", "bindItemToSlot", "bindSpellToSlot", "findFirstEmpty", "getRowCount", "getSlot",
    "removeBinding", "resetPosition", "setLocked", "setRowCount", "slotCount",
  ], "API");
});
check("before the character is known nothing is loaded — A's browser-wide cache stays off the bar", () => {
  eq(slotsNow(), slots18(), "empty bar");
});
check("a playerStatsUpdated before PlayerDescription changes nothing", () => {
  window.__hbLoginKey = { server: SERVER, account: ACCOUNT };
  window.__sessionHandle = makeHandle(CHAR_B);
  pdLanded = false;
  serverList = [];
  window.__pluginClient.events.emit("playerStatsUpdated", {});
  eq(slotsNow(), slots18(), "still empty");
  ok(statsAtMount >= 1, "hotbar listens for playerStatsUpdated");
  eq(statsHandlers(), statsAtMount, "still listening");
});
check("PlayerDescription with NO shortcuts: B's cached spell kept, B's stale item flushed, none of A's", () => {
  pdLanded = true;
  window.__pluginClient.events.emit("playerStatsUpdated", {});
  eq(slotsNow(), slots18({ 4: { spellId: SPELL_B } }));
  eq(JSON.parse(localStorage.getItem(kB)).slots, slots18({ 4: { spellId: SPELL_B } }), "saved under B's key");
  eq(JSON.parse(localStorage.getItem(LEGACY)).slots[0], { itemGuid: ITEM_A1 }, "the old key is untouched");
  eq(localStorage.getItem(kA), null, "A's key not created");
  eq(statsHandlers(), statsAtMount - 1, "one merge → the hotbar's listener removed");
});
const statsTargetBarOnly = statsAtMount - 1;
check("new binds save under B's key; no A guid ever reaches the wire", () => {
  calls.length = 0;
  window.__hotbar.bindItemToSlot(0, ITEM_B);
  eq(calls.filter((c) => c[0] === "addShortcut"), [["addShortcut", 0, ITEM_B, 0, 0]]);
  eq(JSON.parse(localStorage.getItem(kB)).slots[0], { itemGuid: ITEM_B }, "B's key");
  eq(calls.some((c) => c.includes(ITEM_A1) || c.includes(ITEM_A2)), false, "no A guid on the wire");
});
dispose();
check("dispose removes the API and every bus handler", () => {
  eq(window.__hotbar, undefined);
  eq(statsHandlers(), 0);
});

console.log("\n[6] mount — re-mount in the world, and a server list");
seedStorage();
pdLanded = false;
serverList = [];
window.__sessionHandle = makeHandle(CHAR_B);
dispose = hotbar.mount({ client: window.__pluginClient });
check("character already known at mount → its own cache shows at once", () => {
  eq(slotsNow(), slots18({ 4: { spellId: SPELL_B }, 5: { itemGuid: ITEM_B_STALE } }));
});
check("non-empty server list = PlayerDescription: server items win, cached spell fills the rest", () => {
  serverList = [...triple(5, ITEM_B)];
  window.__pluginClient.events.emit("playerStatsUpdated", {});
  eq(slotsNow(), slots18({ 4: { spellId: SPELL_B }, 5: { itemGuid: ITEM_B, wcid: 0 } }));
});
dispose();

console.log("\n[7] mount — ?hotbarPerChar=off (the browser-wide cache, read at mount)");
seedStorage();
pdLanded = true;
serverList = [];
window.__sessionHandle = makeHandle(CHAR_B);
globalThis.location = { search: "?hotbarPerChar=off" };
dispose = hotbar.mount({ client: window.__pluginClient });
check("legacy: the browser-wide cache loads at mount, whoever is playing", () => {
  eq(slotsNow(), slots18({ 0: { itemGuid: ITEM_A1 }, 1: { itemGuid: ITEM_A2 }, 2: { spellId: SPELL_A } }));
  eq(statsHandlers(), statsTargetBarOnly, "no hotbar playerStatsUpdated listener");
});
check("legacy: an empty server list never reconciles, binds save to the browser-wide key", () => {
  window.__pluginClient.events.emit("playerStatsUpdated", {});
  eq(slotsNow()[0], { itemGuid: ITEM_A1 }, "unchanged");
  window.__hotbar.bindSpellToSlot(3, 55);
  eq(JSON.parse(localStorage.getItem(LEGACY)).slots[3], { spellId: 55 }, "browser-wide key");
  eq(JSON.parse(localStorage.getItem(kB)).slots[3], null, "B's key untouched");
});
dispose();
globalThis.location = { search: "" };

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
