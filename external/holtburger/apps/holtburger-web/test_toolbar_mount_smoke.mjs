// HUD overhaul 2026-10-05 — unified toolbar mount smoke test (no browser).
//
// Run from apps/holtburger-web/:  node test_toolbar_mount_smoke.mjs
//
// Mounts plugins/hotbar.js (which mounts plugins/target-bar.js's controls
// into its ToolbarField) against a tiny in-process fake DOM and drives the
// real event handlers: exactly one toolbar root, retail element placement,
// panel buttons → main-panel views (+ Highlight state), combat-mode button →
// setCombatMode, selection → name + health meter, backpack drop → moveItem,
// ShortcutBar2 opt-in, tooltips, slot binding by drop, and clean disposal.
// It cannot check pixels — the orchestrator's screenshots do that.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── fake DOM ─────────────────────────────────────────────────────────
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
  if (s === ":focus-visible") return false;
  let rest = s.replace(/:focus-visible/g, "\u0000");
  if (rest.includes("\u0000")) return false;
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  for (const m of rest.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(m[1])) return false;
  for (const m of rest.matchAll(/#([\w-]+)/g)) if (el.id !== m[1]) return false;
  for (const m of rest.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)) {
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
function dispatch(target, type, init = {}) {
  const ev = {
    type, target, bubbles: true, defaultPrevented: false, _stop: false,
    button: 0, pointerId: 1, clientX: 0, clientY: 0, relatedTarget: null,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
    ...init,
  };
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  for (let i = path.length - 1; i >= 0 && !ev._stop; i--) {
    for (const l of [...path[i].listeners]) if (l.type === type && l.capture) { ev.currentTarget = path[i]; l.fn(ev); }
  }
  for (let i = 0; i < path.length && !ev._stop; i++) {
    for (const l of [...path[i].listeners]) if (l.type === type && !l.capture) { ev.currentTarget = path[i]; l.fn(ev); }
  }
  return ev;
}
function makeDataTransfer(data) {
  const store = new Map(Object.entries(data));
  return {
    types: [...store.keys()],
    dropEffect: "none", effectAllowed: "all",
    getData: (k) => store.get(k) ?? "",
    setData: (k, v) => store.set(k, String(v)),
    setDragImage() {},
  };
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
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.fetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}), text: () => Promise.resolve("") });

// ─── fake game session ────────────────────────────────────────────────
const calls = [];
const PLAYER = 0x50000001;
let selected = 0;
let stanceLow = 0x3D;
let mpOpen = false;
let mpView = null;
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
  setCombatMode: (m) => calls.push(["setCombatMode", m]),
  playerInventory: () => [],
  useObject: (g) => calls.push(["useObject", g]),
  moveItem: (g, c, p) => calls.push(["moveItem", g, c, p]),
  objectName: (g) => (g === 0x80000AAA ? "Drudge Skulker" : g === 0x7000BBBB ? "Healing Kit" : undefined),
  objectHealthFraction: (g) => (g === 0x80000AAA ? 0.5 : -1),
  queryHealth: (g) => calls.push(["queryHealth", g]),
  getSpellRecord: (id) => new Map([["name", id === 27 ? "Flame Bolt I" : "Heal Self I"], ["isSelfTargeted", id !== 27]]),
  addShortcut: (...a) => calls.push(["addShortcut", ...a]),
  removeShortcut: (...a) => calls.push(["removeShortcut", ...a]),
  playerShortcuts: () => [],
  combatMode: () => (stanceLow === 0x49 ? 8 : 1),
  castTargetedSpell: (tgt, sid) => calls.push(["castTargetedSpell", tgt, sid]),
  castUntargetedSpell: (sid) => calls.push(["castUntargetedSpell", sid]),
};
window.__mainPanel = {
  toggleView(v) { calls.push(["toggleView", v]); if (mpOpen && mpView === v) { mpOpen = false; mpView = null; } else { mpOpen = true; mpView = v; } },
  isOpen: () => mpOpen,
  currentViewId: () => mpView,
};
window.liveScene3d = { entityManager: { getSelectedTarget: () => selected, entityMap: new Map() } };
window.__getCurrentStanceLow = () => stanceLow;

const hotbar = await import(pathToFileURL(resolvePath(__dirname, "plugins/hotbar.js")).href);
const targetBar = await import(pathToFileURL(resolvePath(__dirname, "plugins/target-bar.js")).href);

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; console.log(`  [PASS] ${name}`); }
  catch (e) { fail += 1; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
function ok(c, label) { if (!c) throw new Error(label); }
function eq(a, b, label = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${label} expected ${y}, got ${x}`); }
const lastCall = (name) => [...calls].reverse().find((c) => c[0] === name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stale pre-overhaul overlay must be cleared by target-bar's mount.
const stale = document.createElement("div");
stale.id = "hb-target-bar";
document.body.appendChild(stale);
const disposeTargetBar = targetBar.mount({});
const dispose = hotbar.mount({ client: window.__pluginClient });

const root = document.getElementById("hb-hotbar");
const field = root?.querySelector(".hb-hotbar-field");
const byPanel = (k) => field.querySelector(`[data-panel='${k}']`);

console.log("[1] One toolbar");
check("exactly one toolbar root; the legacy #hb-target-bar is gone", () => {
  ok(root, "#hb-hotbar mounted");
  eq(document.getElementById("hb-target-bar"), null, "legacy overlay");
  eq(document.body.children.filter((c) => /^hb-(hotbar|target-bar)$/.test(c.id)).length, 1, "toolbar roots");
});
check("controls and slots share the ToolbarField", () => {
  ok(field.querySelector(".htb-stance") && field.querySelector(".htb-pack") && field.querySelector(".htb-target"), "top band");
  eq(field.querySelectorAll(".htb-panel-btn").length, 6, "6 retail panel buttons");
  eq(field.querySelectorAll(".hb-hotbar-slot").length, 18, "18 persisted slots");
});
check("retail placement: stance (0,0) 55×58, backpack (238,0) 63×58, slot 1 at (6,58)", () => {
  const s = field.querySelector(".htb-stance").style;
  eq([s.left, s.top, s.width, s.height], ["0px", "0px", "55px", "58px"]);
  const p = field.querySelector(".htb-pack").style;
  eq([p.left, p.top, p.width, p.height], ["238px", "0px", "63px", "58px"]);
  const slot = field.querySelector(".hb-hotbar-slot").style;
  eq([slot.left, slot.top], ["6px", "58px"]);
});
check("default = one shortcut row (row 2 hidden)", () => {
  ok(root.classList.contains("hb-hotbar-rows-1") && !root.classList.contains("hb-hotbar-rows-2"), "rows-1 class");
  eq(window.__hotbar.getRowCount(), 1);
  eq(window.__hotbar.slotCount(), 9);
});

console.log("\n[2] Panel buttons + backpack");
check("Spellbook button toggles the spellbook view and lights its Highlight state", () => {
  dispatch(byPanel("magic"), "click");
  eq(lastCall("toggleView"), ["toggleView", "spellbook"]);
  ok(byPanel("magic").classList.contains("is-open"), "Highlight while open");
  ok(!byPanel("world").classList.contains("is-open"), "others stay Normal");
  dispatch(byPanel("magic"), "click");
  ok(!byPanel("magic").classList.contains("is-open"), "Normal after close");
});
// HUD overhaul 2026-10-05: Social opens the unified social hub view
// (plugins/social-panel.js); without __toggleSocialPanel it falls back to
// toggleView("social").
check("Social → social hub view (Highlight)", () => {
  dispatch(byPanel("social"), "click");
  eq(lastCall("toggleView"), ["toggleView", "social"]);
  ok(byPanel("social").classList.contains("is-open"), "lit");
});
mpView = "fellowship"; // switched tabs inside the main panel (F9 / tab strip)
await sleep(300);      // the 250 ms panel-visibility tick picks it up
check("Social stays lit on its Fellowship tab (no click needed)", () => {
  ok(byPanel("social").classList.contains("is-open"), "lit on fellowship");
});
check("backpack opens inventory and takes over the Highlight", () => {
  dispatch(field.querySelector(".htb-pack"), "click");
  eq(lastCall("toggleView"), ["toggleView", "inventory"]);
  ok(field.querySelector(".htb-pack").classList.contains("is-open"), "backpack lit");
  ok(!byPanel("social").classList.contains("is-open"), "social back to Normal");
  dispatch(field.querySelector(".htb-pack"), "click");
  ok(!field.querySelector(".htb-pack").classList.contains("is-open"), "closed");
});
check("item dropped on the backpack → moveItem(item, player, 0) (HandleDropRelease)", () => {
  const pack = field.querySelector(".htb-pack");
  const dt = makeDataTransfer({ "application/x-hb-inv-guid": String(0x7000BBBB) });
  const over = dispatch(pack, "dragover", { dataTransfer: dt });
  ok(over.defaultPrevented, "drop accepted");
  dispatch(pack, "drop", { dataTransfer: dt });
  eq(lastCall("moveItem"), ["moveItem", 0x7000BBBB, PLAYER, 0]);
});
check("a spell drag is NOT accepted by the backpack", () => {
  const pack = field.querySelector(".htb-pack");
  const over = dispatch(pack, "dragover", { dataTransfer: makeDataTransfer({ "application/x-hb-spell-id": "27" }) });
  ok(!over.defaultPrevented, "rejected");
});

console.log("\n[3] Combat mode + selection");
check("stance button shows Peace sprite and asks for the weapon's mode", () => {
  const st = field.querySelector(".htb-stance");
  ok(String(st.style["--sp"]).includes("0x06004CEC"), "peace sprite");
  dispatch(st, "click");
  eq(lastCall("setCombatMode"), ["setCombatMode", 2], "unarmed → melee");
  ok(String(st.style["--sp"]).includes("0x06004CEE"), "optimistic melee sprite");
});
check("Magic stance ghosts the shortcut numbers (RecvNotice_SetCombatMode)", () => {
  stanceLow = 0x49;
  window.__pluginClient.events.emit("playerStatsUpdated", {});
  ok(root.classList.contains("hb-toolbar-magic"), "magic class");
  ok(String(field.querySelector(".htb-stance").style["--sp"]).includes("0x06004CF2"), "magic sprite");
  stanceLow = 0x3D;
  window.__pluginClient.events.emit("playerStatsUpdated", {});
  ok(!root.classList.contains("hb-toolbar-magic"), "peace again");
});
check("selection: Use/Examine enable, name + cached health meter shown, health queried", () => {
  const useBtn = field.querySelector(".htb-use");
  ok(useBtn.disabled, "Use ghosted with no selection");
  selected = 0x80000AAA;
  window.__pluginClient.events.emit("selectionChanged", { guid: selected });
  ok(!useBtn.disabled && !field.querySelector(".htb-examine").disabled, "enabled");
  const nameHost = field.querySelector(".htb-target-name");
  eq(nameHost.textContent, "Drudge Skulker", "name");
  const health = field.querySelector(".htb-target-health");
  ok(!health.hidden, "meter visible");
  eq(field.querySelector(".htb-target-health-fill").style.width, "70px", "50% of 140");
  eq(lastCall("queryHealth"), ["queryHealth", 0x80000AAA]);
  window.__pluginClient.events.emit("entityHealthUpdated", { guid: 0x80000AAA, fraction: 0.25 });
  eq(field.querySelector(".htb-target-health-fill").style.width, "35px", "health update");
  dispatch(useBtn, "click");
  eq(lastCall("useObject"), ["useObject", 0x80000AAA]);
});
check("deselect → 'No selection', meter hidden", () => {
  selected = 0;
  window.__pluginClient.events.emit("selectionChanged", { guid: 0 });
  eq(field.querySelector(".htb-target-name").textContent, "No selection");
  ok(field.querySelector(".htb-target-health").hidden, "hidden");
});

console.log("\n[4] Shortcut slots");
check("dropping a targeted spell binds it (server AddShortcut) and casts on the target", () => {
  const slot = field.querySelectorAll(".hb-hotbar-slot")[0];
  dispatch(slot, "drop", { dataTransfer: makeDataTransfer({ "application/x-hb-spell-id": "27" }) });
  eq(window.__hotbar.getSlot(0), { spellId: 27 });
  eq(lastCall("addShortcut"), ["addShortcut", 0, 0, 27, 0]);
  stanceLow = 0x49;
  selected = 0x80000AAA;
  dispatch(slot, "click");
  // getSpellRecord returns a Map with isSelfTargeted=false for spell 27 —
  // before the Map fix this went out as an untargeted self-cast.
  eq(lastCall("castTargetedSpell"), ["castTargetedSpell", 0x80000AAA, 27]);
  eq(lastCall("castUntargetedSpell"), undefined, "no untargeted cast");
  stanceLow = 0x3D;
  selected = 0;
});
check("ShortcutBar2 opt-in via setRowCount / grip double-click, persisted", () => {
  eq(window.__hotbar.setRowCount(2), 2);
  ok(root.classList.contains("hb-hotbar-rows-2"), "rows-2 class");
  eq(localStorage.getItem("hb.hotbar.rows.v1"), "2", "persisted");
  dispatch(root.querySelector(".hb-hotbar-grip"), "dblclick");
  eq(window.__hotbar.getRowCount(), 1, "dblclick toggles back");
  eq(window.__hotbar.findFirstEmpty(), 1, "first empty VISIBLE slot");
});

console.log("\n[5] Tooltips");
await (async () => {
  const tip = document.getElementById("hb-toolbar-tip");
  check("one kit tooltip element exists", () => { ok(tip && tip.classList.contains("hbk-tooltip"), "hbk-tooltip"); });
  dispatch(byPanel("magic"), "pointerover");
  await sleep(420);
  check("hovering Spellbook shows 'Spellbook (F5)'", () => {
    ok(!tip.hidden, "visible");
    eq(tip.textContent, "Spellbook (F5)");
  });
  dispatch(field.querySelectorAll(".hb-hotbar-slot")[0], "pointerover");
  check("moving onto slot 1 retargets instantly: bound spell name + key", () => {
    ok(tip.textContent.startsWith("Flame Bolt I (1)"), tip.textContent);
  });
  dispatch(field.querySelector(".htb-stance"), "pointerover");
  check("stance tooltip carries the backtick hotkey", () => {
    ok(tip.textContent.startsWith("Peace Mode (`)"), tip.textContent);
  });
  dispatch(root, "pointerdown");
  check("pointerdown hides the tooltip", () => ok(tip.hidden, "hidden"));
})();

console.log("\n[6] Dispose");
check("disposer removes the toolbar, tooltip and window.__hotbar", () => {
  dispose();
  disposeTargetBar();
  eq(document.getElementById("hb-hotbar"), null, "root");
  eq(document.getElementById("hb-toolbar-tip"), null, "tooltip");
  eq(window.__hotbar, undefined, "api");
  let n = 0;
  for (const set of busHandlers.values()) n += set.size;
  eq(n, 0, "bus handlers unsubscribed");
});

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
