// HUD overhaul 2026-10-05 — DOM smoke test for the options / examine /
// popup plugins (no browser: a small in-file DOM shim).
//
// Run with:
//   cd apps/holtburger-web/
//   node test_hud_popups_dom_smoke.mjs
//
// Mounts the real code paths — every Options tab + the key-bindings
// page + Apply/Cancel, the examine body for an inventory item / a
// creature / nothing, the right-click menu with keyboard navigation,
// the modal confirm with Enter/Esc, the salvage confirm, the lifestone
// popup and the hover tooltip — and asserts they build the kit DOM
// without throwing, use no native unstyled controls, never print raw
// hex to the player, and keep keys away from the game while open.
// It cannot judge pixels; the orchestrator's screenshots do that.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (p) => import(pathToFileURL(resolvePath(__dirname, p)).href);

// ── Mini DOM ───────────────────────────────────────────────────────────
class Ev {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    Object.assign(this, init);
    this.defaultPrevented = false;
    this._stop = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; }
}
class CustomEv extends Ev { constructor(t, i = {}) { super(t, i); this.detail = i.detail; } }

class Listeners {
  constructor() { this._l = []; }
  addEventListener(type, fn, opt) {
    const capture = typeof opt === "boolean" ? opt : !!opt?.capture;
    this._l.push({ type, fn, capture });
  }
  removeEventListener(type, fn, opt) {
    const capture = typeof opt === "boolean" ? opt : !!opt?.capture;
    this._l = this._l.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture));
  }
  _fire(ev, capturePhase) {
    for (const l of [...this._l]) {
      if (l.type !== ev.type || l.capture !== capturePhase) continue;
      ev.currentTarget = this;
      typeof l.fn === "function" ? l.fn.call(this, ev) : l.fn.handleEvent(ev);
      if (ev._stop) return;
    }
  }
}

function parseCompound(s) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push([m[4], m[5]]);
  }
  return out;
}
function matchCompound(el, c) {
  if (!(el instanceof El)) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const [a, v] of c.attrs) {
    const got = el.getAttribute(a);
    if (got == null) return false;
    if (v !== undefined && got !== v) return false;
  }
  return true;
}
function matches(el, sel) {
  return sel.split(",").some((part) => {
    const chain = part.trim().split(/\s+/).map(parseCompound);
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let i = chain.length - 2;
    let p = el.parentNode;
    while (i >= 0 && p) {
      if (matchCompound(p, chain[i])) i--;
      p = p.parentNode;
    }
    return i < 0;
  });
}

class ClassList {
  constructor(el) { this.el = el; }
  _get() { return String(this.el._className || "").split(/\s+/).filter(Boolean); }
  _set(a) { this.el._className = a.join(" "); }
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

function mkStyle() {
  const props = {};
  return new Proxy(props, {
    get(t, k) {
      if (k === "setProperty") return (n, v) => { t[n] = String(v); };
      if (k === "getPropertyValue") return (n) => t[n] ?? "";
      if (k === "removeProperty") return (n) => { delete t[n]; };
      return t[k] ?? "";
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

class El extends Listeners {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._attrs = {};
    this._className = "";
    this.classList = new ClassList(this);
    this.style = mkStyle();
    this.dataset = {};
    this._text = "";
    this.scrollTop = 0;
    this.currentCSSZoom = 1;
    this.value = "";
    this.checked = false;
    this.disabled = false;
  }
  get className() { return this._className; }
  set className(v) { this._className = String(v); }
  get id() { return this._attrs.id ?? ""; }
  set id(v) { this._attrs.id = String(v); }
  setAttribute(k, v) {
    if (k === "class") this._className = String(v);
    else this._attrs[k] = String(v);
    if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) {
    if (k === "class") return this._className || null;
    if (k.startsWith("data-")) {
      const dk = k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());
      if (this.dataset[dk] !== undefined) return String(this.dataset[dk]);
    }
    return this._attrs[k] ?? null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) { delete this._attrs[k]; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    this.children.push(c); c.parentNode = this; return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    c.parentNode = this; return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null; return c;
  }
  remove() { this.parentNode?.removeChild(this); }
  get firstChild() { return this.children[0] ?? null; }
  get childElementCount() { return this.children.length; }
  get parentElement() { return this.parentNode instanceof El ? this.parentNode : null; }
  get isConnected() {
    let p = this;
    while (p) { if (p === document.documentElement) return true; p = p.parentNode; }
    return false;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = String(v ?? ""); }
  get innerHTML() { return ""; }
  set innerHTML(v) {
    if (String(v).trim()) throw new Error(`innerHTML with markup used on <${this.tagName}>: ${String(v).slice(0, 60)}`);
    this.textContent = "";
  }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  closest(sel) { let p = this; while (p instanceof El) { if (matches(p, sel)) return p; p = p.parentNode; } return null; }
  matches(sel) { return matches(this, sel); }
  _walk(fn) { for (const c of this.children) { if (fn(c) === true) return true; if (c._walk(fn) === true) return true; } return false; }
  querySelectorAll(sel) { const out = []; this._walk((n) => { if (matches(n, sel)) out.push(n); }); return out; }
  querySelector(sel) { let hit = null; this._walk((n) => { if (matches(n, sel)) { hit = n; return true; } }); return hit; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 130, bottom: 50, width: 120, height: 40, x: 10, y: 10 }; }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = document.body; }
  click() { this.dispatchEvent(new Ev("click")); }
  select() {}
  scrollIntoView() {}
  dispatchEvent(ev) {
    ev.target = ev.target ?? this;
    const path = [];
    for (let p = this; p; p = p.parentNode) path.push(p);
    path.push(document, window);
    for (let i = path.length - 1; i >= 0 && !ev._stop; i--) path[i]._fire(ev, true);
    for (let i = 0; i < path.length && !ev._stop; i++) {
      if (i > 0 && !ev.bubbles) break;
      path[i]._fire(ev, false);
    }
    return !ev.defaultPrevented;
  }
  get title() { return this._attrs.title ?? ""; }
  set title(v) { this._attrs.title = String(v); }
  get htmlFor() { return this._attrs.for ?? ""; }
  set htmlFor(v) { this._attrs.for = String(v); }
}

class MemStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

const winListeners = new Listeners();
globalThis.window = globalThis;
globalThis.addEventListener = winListeners.addEventListener.bind(winListeners);
globalThis.removeEventListener = winListeners.removeEventListener.bind(winListeners);
globalThis._fire = winListeners._fire.bind(winListeners);
globalThis.dispatchEvent = (ev) => { ev.target = ev.target ?? window; winListeners._fire(ev, true); if (!ev._stop) winListeners._fire(ev, false); return true; };
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.devicePixelRatio = 1;
globalThis.localStorage = new MemStorage();
globalThis.Event = Ev;
globalThis.CustomEvent = CustomEv;
globalThis.MouseEvent = Ev;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.getComputedStyle = () => ({ position: "fixed", width: "300px", height: "362px", borderLeftWidth: "0", borderRightWidth: "0", borderTopWidth: "0", borderBottomWidth: "0" });
try { Object.defineProperty(globalThis, "location", { value: { search: "", reload() { globalThis.__reloaded = true; } }, configurable: true }); } catch (_) {}

const docListeners = new Listeners();
const html = new El("html");
const head = new El("head");
const bodyEl = new El("body");
html.appendChild(head);
html.appendChild(bodyEl);
globalThis.document = {
  documentElement: html,
  head,
  body: bodyEl,
  activeElement: bodyEl,
  createElement: (t) => new El(t),
  getElementById: (id) => html.querySelector(`#${id}`),
  querySelector: (s) => html.querySelector(s),
  querySelectorAll: (s) => html.querySelectorAll(s),
  addEventListener: docListeners.addEventListener.bind(docListeners),
  removeEventListener: docListeners.removeEventListener.bind(docListeners),
  _fire: docListeners._fire.bind(docListeners),
  dispatchEvent: (ev) => { ev.target = ev.target ?? document; docListeners._fire(ev, true); if (!ev._stop) docListeners._fire(ev, false); return true; },
};
html.ownerDocument = document;

// Keys a test "types": dispatched at the focused element (or body) so
// capture listeners on document/window run first, like a browser.
function press(key, target = document.activeElement || bodyEl) {
  const ev = new Ev("keydown", { key, code: key });
  target.dispatchEvent(ev);
  return ev;
}

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  [OK] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function guard(name, fn) {
  try { await fn(); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} threw — ${e?.stack?.split("\n").slice(0, 3).join(" | ")}`); }
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const textOf = (el) => el.textContent;
const nativeControls = (root) => root.querySelectorAll("input").filter((i) =>
  (i.type === "range" && !i.classList.contains("hbk-range"))
  || (i.type === "checkbox" && !i.classList.contains("hbk-check"))).length
  + root.querySelectorAll("select").filter((s) => !s.classList.contains("hbk-select")).length;

// Fake session handle with a few character options.
const charOpts = new Map([[0x31, true], [0x0A, false]]);
const sent = [];
window.__sessionHandle = {
  setCharacterOption: (i, v) => { sent.push([i, v]); charOpts.set(i, v); },
  isCharacterOptionEnabled: (i) => !!charOpts.get(i),
  playerInventory: () => [{ guid: 0x50000001, name: "Chainmail Hauberk", value: 1250, stackSize: 1, itemType: 0x2, equipMask: 0, validLocations: 0x00000600, iconId: 0 }],
  getObjectAppraisal: (g) => g === 0x50000001 ? JSON.stringify({
    identifySuccess: true, identifyFlags: 0,
    properties: { ints: { Value: 1250, EncumbranceVal: 900, ArmorLevel: 120, ItemWorkmanship: 6, ItemMaxMana: 800, ItemCurMana: 400, ItemSpellcraft: 150 }, strings: { LongDesc: "Sturdy mail." }, bools: {} },
    armorProfile: { slashing: 1.3, piercing: 0.9, bludgeoning: 0.5, cold: 0.2, fire: 0.4, acid: 0.6, nether: 0, lightning: 1.7 },
    armorHighlight: 0x0001, armorColor: 0x0001, spellBook: [2],
  }) : undefined,
  requestAppraisal: () => {},
  queryHealth: () => {},
  getSpellRecord: () => new Map([["name", "Strength Other I"]]),
  getObjectInscription: (g) => g === 0x50000001 ? "For Asheron!" : undefined,
};
window.__pluginClient = { events: { on() {}, off() {}, emit() {} } };

// ── Options view ───────────────────────────────────────────────────────
console.log("== options view ==");
const options = await load("plugins/options-panel.js");
await load("ui/hud_kit.js").then((k) => k.installHudKit?.()).catch(() => {});
const hud = await load("ui/hud_scale.js");
await guard("options mount", async () => {
  let closed = 0;
  window.__mainPanel = { closeView: () => { closed++; }, setTitle: () => true };
  const host = new El("div");
  bodyEl.appendChild(host);
  const cleanup = options.view.mount(host, {});
  const root = host.querySelector(".hb-opt-root");
  check("root + single tab strip + scroll body + footer",
    !!root && host.querySelectorAll(".hbk-tabs").length === 1 && !!host.querySelector(".hb-opt-body.hbk-scroll")
    && !!host.querySelector(".hbk-footer"));
  const tabs = host.querySelectorAll(".hbk-tab");
  check("4 retail tabs (Gameplay/Character/Chat/Config)",
    tabs.map(textOf).join("|") === "Gameplay|Character|Chat|Config", tabs.map(textOf).join("|"));
  const btns = host.querySelectorAll(".hbk-footer .hbk-btn").map(textOf).join("|");
  check("footer = Apply | OK | Cancel", btns === "Apply|OK|Cancel", btns);
  // Gameplay page: HUD scale slider etc.
  const hudRow = host.querySelectorAll(".hb-graphics-range").find((r) => /HUD scale/.test(r.textContent));
  check("Gameplay: HUD scale slider present", !!hudRow);
  const slider = hudRow?.querySelector("input");
  check("HUD scale slider is kit-styled, 60–200 step 5", slider?.classList.contains("hbk-range") && slider.min === "60" && slider.max === "200" && slider.step === "5");
  check("Gameplay: Reset window positions button", host.querySelectorAll("button").some((b) => b.textContent === "Reset window positions"));
  check("Gameplay: Use mouse turning row reflects server bit", host.querySelectorAll(".hb-opt-bool").some((r) => /Use mouse turning/.test(r.textContent) && r.querySelector("input").checked === true));
  check("Gameplay: no native controls", nativeControls(host) === 0, String(nativeControls(host)));
  // Drag the HUD scale to 150 % → applied on change.
  slider.value = "150";
  slider.dispatchEvent(new Ev("input"));
  slider.dispatchEvent(new Ev("change"));
  check("HUD scale applied on change (multiplier 1.5)", hud.getHudScaleMultiplier() === 1.5, String(hud.getHudScaleMultiplier()));
  // Reset window positions with saved keys → live reset via
  // ui/ac_window_position.js resetAllWindowPositions (no reload prompt).
  localStorage.setItem("hb.window.10000600", "{}");
  localStorage.setItem("hb_panel_pos_main-panel", "{}");
  host.querySelectorAll("button").find((b) => b.textContent === "Reset window positions").click();
  check("reset cleared the saved window keys", localStorage.getItem("hb.window.10000600") === null && localStorage.getItem("hb_panel_pos_main-panel") === null);
  const dlg = document.getElementById("hb-modal-dialog");
  check("live reset — no reload prompt", !dlg || dlg.getAttribute("data-open") !== "1", dlg?.textContent);
  check("no page reload", !globalThis.__reloaded);
  await tick();
  // Each tab renders without native controls / markup strings.
  for (const t of tabs) {
    t.click();
    check(`tab ${t.textContent}: renders, no native controls`, nativeControls(host) === 0 && host.querySelector(".hb-opt-body").children.length > 0);
  }
  // Character tab toggle → wire + Cancel reverts it.
  tabs[1].click();
  const runRow = host.querySelectorAll(".hb-opt-bool").find((r) => /Run as default movement/.test(r.textContent));
  const runCb = runRow.querySelector("input");
  runCb.checked = true;
  runCb.dispatchEvent(new Ev("change"));
  check("character option sent on toggle", sent.some(([i, v]) => i === 0x0A && v === true));
  // Config: graphics preset buttons are brass tags.
  tabs[3].click();
  check("Config: Sound + graphics sections", /Sound/.test(host.textContent) && host.querySelectorAll(".hbk-btn-brass").length === 4);
  // Gameplay → Configure keyboard… → bindings page → Back.
  tabs[0].click();
  host.querySelectorAll("button").find((b) => /Configure keyboard/.test(b.textContent)).click();
  check("key bindings page opens", /Key Bindings/.test(host.querySelector(".hb-opt-body").textContent));
  host.querySelectorAll("button").find((b) => /Back/.test(b.textContent)).click();
  check("Back returns to Gameplay", /HUD scale/.test(host.querySelector(".hb-opt-body").textContent));
  // Cancel → HUD scale + character option reverted, panel closed.
  host.querySelectorAll(".hbk-footer .hbk-btn").find((b) => b.textContent === "Cancel").click();
  check("Cancel reverts HUD scale to 100 %", hud.getHudScaleMultiplier() === 1, String(hud.getHudScaleMultiplier()));
  check("Cancel re-sends the original character option", sent[sent.length - 1]?.[0] === 0x0A && sent[sent.length - 1]?.[1] === false, JSON.stringify(sent));
  check("Cancel closes the view", closed === 1);
  cleanup();
  check("cleanup removes the root", !host.querySelector(".hb-opt-root"));
  host.remove();
});

// ── Examine body ───────────────────────────────────────────────────────
console.log("== examine body ==");
const exa = await load("plugins/examine-target.js");
await guard("examine inventory item", async () => {
  const host = new El("div");
  bodyEl.appendChild(host);
  let title = null;
  const cleanup = exa.mountExamineBody(host, { guid: 0x50000001, fromInventory: true }, { setTitle: (t) => { title = t; } });
  const t = host.textContent;
  check("title is the item name (not 'Examine: …')", exa.examineTitleFor({ guid: 0x50000001, fromInventory: true }) === "Chainmail Hauberk");
  check("header: retail Value / Burden lines", /Value: 1,250/.test(t) && /Burden: 900 Burden Units/.test(t), t.slice(0, 120));
  check("icon box shown for items, level box hidden",
    host.querySelector(".hb-exa-iconbox").style.display === "" && host.querySelector(".hb-exa-levelbox").style.display === "none");
  check("gold divider under the header", !!host.querySelector(".hb-exa-root > .hbk-divider"));
  check("armor protections in retail words", /Above Average \(156\)/.test(t) && /Below Average/.test(t) && /Excellent/.test(t), t);
  check("enchanted armor level row is tinted", host.querySelectorAll(".hbk-kv.is-buffed").some((r) => /Armor Level/.test(r.textContent)));
  check("spell list with names", /Strength Other I/.test(t));
  check("mana + spellcraft", /400 \/ 800/.test(t) && /Spellcraft/.test(t));
  check("item identity: type + where worn, no hex", /Armor/.test(t) && /Chest, Abdomen/.test(t) && !/0x[0-9A-F]{4}/i.test(t), t);
  check("inscription on the parchment", host.querySelector(".hb-exa-insc-wrap").style.display === "" && /For Asheron!/.test(host.querySelector(".hb-exa-paper").textContent));
  check("no paperdoll for items", host.querySelector(".hb-exa-paperdoll-wrap").style.display === "none");
  check("no native controls", nativeControls(host) === 0);
  void title;
  cleanup();
  host.remove();
});
await guard("examine creature (debug-stub shape)", async () => {
  window.liveScene3d = { entityManager: { entityMap: new Map([[0xCAFEBABE, { name: "Cragstone Drudge", type: 16, level: 7, health: 84, wcid: 8023, classId: 0x1F4E }]]) } };
  const host = new El("div");
  bodyEl.appendChild(host);
  const cleanup = exa.mountExamineBody(host, { guid: 0xCAFEBABE, fromEntity: true });
  check("creature: level box shows 7", host.querySelector(".hb-exa-levelbox").style.display === "" && host.querySelector(".hb-exa-levelvalue").textContent === "7");
  check("creature: paperdoll slot shown (with a sentinel off-GPU)", host.querySelector(".hb-exa-paperdoll-wrap").style.display === "");
  check("creature: wcid / class / hex stay out of the player view", !/8023|0x1f4e|0x1F4E|CAFEBABE/i.test(host.textContent), host.textContent);
  cleanup();
  host.remove();
});
await guard("examine nothing", async () => {
  const host = new El("div");
  bodyEl.appendChild(host);
  const cleanup = exa.mountExamineBody(host, { guid: 0, fromEntity: true });
  check("empty state message", !!host.querySelector(".hbk-empty"));
  check("title falls back to 'Examine'", exa.examineTitleFor({}) === "Examine");
  cleanup();
  host.remove();
});

// ── Right-click menu ───────────────────────────────────────────────────
console.log("== right-click menu ==");
await load("plugins/radial-menu.js");
await guard("menu open + keys", async () => {
  window.__showExamineFor = (g) => { window.__examined = g; };
  window.__openContextMenuFor({ source: "inv-grid", guid: 0x50000001, name: "Chainmail Hauberk", clientX: 1270, clientY: 700 });
  const menu = document.getElementById("hb-radial-menu");
  check("menu built with kit chrome", menu?.classList.contains("hbk-window") && menu.querySelectorAll(".hbk-row").length >= 1
    && /Examine/.test(menu.querySelector(".hb-rm-list").textContent));
  check("header names the item, no hex", /Chainmail Hauberk/.test(menu.querySelector(".hb-rm-header").textContent) && !/0x/.test(menu.querySelector(".hb-rm-header").textContent));
  check("placed in HUD px inside the viewport", parseFloat(menu.style.left) + 120 <= 1280 && parseFloat(menu.style.top) + 40 <= 720, `${menu.style.left},${menu.style.top}`);
  const down = press("ArrowDown");
  check("ArrowDown swallowed (doesn't walk the character)", down._stop && down.defaultPrevented);
  check("first entry highlighted", menu.querySelectorAll(".hb-rm-item")[0].classList.contains("is-selected"));
  press("Enter");
  check("Enter runs the highlighted entry (Examine) and closes", window.__examined === 0x50000001 && !document.getElementById("hb-radial-menu") && window.__radialMenuOpen === false);
  window.__openContextMenuFor({ source: "inv-grid", guid: 0x50000001, clientX: 10, clientY: 10 });
  press("Escape");
  check("Esc closes the menu", !document.getElementById("hb-radial-menu"));

  // Richer item: ring (two finger slots → Equip ▸ flyout) in a stack.
  const wield = [];
  const split = [];
  const h = window.__sessionHandle;
  const prevInv = h.playerInventory;
  h.playerInventory = () => [{ guid: 0x50000002, name: "Ring", stackSize: 5, itemType: 0x8, equipMask: 0, validLocations: 0x000C0000 }];
  h.setWielded = (g, m) => wield.push([g, m]);
  h.splitStackTo3D = (g, n) => split.push([g, n]);
  window.__openContextMenuFor({ source: "inv-grid", guid: 0x50000002, name: "Ring", clientX: 50, clientY: 50 });
  const rows = document.getElementById("hb-radial-menu").querySelectorAll(".hb-rm-item");
  const equipIdx = rows.findIndex((r) => /^Equip/.test(r.textContent));
  check("Equip entry shows a separate ▸ arrow", equipIdx >= 0 && !!rows[equipIdx].querySelector(".hb-rm-arrow")
    && !/▸/.test(rows[equipIdx].querySelector(".hbk-grow").textContent));
  for (let i = 0; i <= equipIdx; i++) press("ArrowDown");
  press("ArrowRight");
  const sub = document.getElementById("hb-radial-submenu");
  check("ArrowRight opens the flyout with its first entry highlighted",
    !!sub && sub.querySelectorAll(".hb-rm-item")[0].classList.contains("is-selected"));
  press("ArrowLeft");
  check("ArrowLeft closes the flyout, menu stays", !document.getElementById("hb-radial-submenu") && !!document.getElementById("hb-radial-menu"));
  press("ArrowRight");
  press("ArrowDown");
  press("Enter");
  check("Enter in the flyout equips the 2nd slot", wield.length === 1 && wield[0][1] === 0x00080000, JSON.stringify(wield));
  // Shift-click split: the menu opens pre-armed on the Split row.
  window.__openContextMenuFor({ source: "inv-grid", guid: 0x50000002, name: "Ring", clientX: 50, clientY: 50, focusAction: "split" });
  const inp = document.getElementById("hb-radial-menu").querySelector(".hb-rm-split-input");
  check("focusAction split arms the Split field (not the row above it)", !!inp && document.activeElement === inp);
  inp.value = "3";
  const ev = new Ev("keydown", { key: "Enter" });
  inp.dispatchEvent(ev);
  check("Enter in the field splits 3", split.length === 1 && split[0][1] === 3 && !document.getElementById("hb-radial-menu"), JSON.stringify(split));
  h.playerInventory = prevInv;
});

// ── Modal / salvage / lifestone ────────────────────────────────────────
console.log("== confirms ==");
const modal = await load("plugins/modal-dialog.js");
await guard("modal confirm", async () => {
  let r = null;
  modal.modalConfirmCallback({ title: "Drop Bonded Item", message: "Drop it?", onConfirm: () => { r = true; }, onCancel: () => { r = false; } });
  const d = document.getElementById("hb-modal-dialog");
  check("retail dialog chrome class", d.classList.contains("hb-dlg") && d.getAttribute("data-open") === "1");
  const ev = press("Enter");
  check("Enter confirms and is swallowed", r === true && ev._stop);
  await tick();
  modal.modalConfirmCallback({ title: "X", message: "Y", onConfirm: () => { r = "yes"; }, onCancel: () => { r = "no"; } });
  await tick();
  press("Tab");
  press("Enter");
  check("Tab to Cancel then Enter cancels", r === "no");
});
const salvage = await load("plugins/salvage-confirm.js");
await guard("salvage confirm", async () => {
  let res = null;
  salvage.show({ toolLabel: "Ust", items: [{ guid: 1, label: "Robe" }, { guid: 2 }], onConfirm: () => { res = "c"; }, onCancel: () => { res = "x"; } });
  const s = document.getElementById("hb-salvage-confirm");
  check("salvage uses dialog chrome + kit buttons", s.classList.contains("hb-dlg") && s.querySelectorAll(".hbk-btn").length === 2);
  check("unnamed item reads as words, not 0x guid", /an unnamed item/.test(s.textContent) && !/0x0000/.test(s.textContent), s.textContent);
  press("Escape");
  check("Esc cancels", res === "x" && s.getAttribute("data-open") === "0");
});
const life = await load("plugins/lifestone-popup.js");
await guard("lifestone popup", async () => {
  const calls = [];
  const bus = new Map();
  const client = {
    events: { on: (n, f) => bus.set(n, f), off: () => {} },
    player: { useObject: (g) => calls.push(["use", g]), recallToLifestone: () => calls.push(["recall"]) },
  };
  const dispose = life.mount({ client });
  bus.get("lifestoneClicked")({ guid: 0x7A001 });
  const p = document.getElementById("hb-lifestone-popup");
  check("opens with dialog chrome", p.classList.contains("hb-dlg") && p.getAttribute("data-open") === "1");
  press("Enter");
  check("first Enter highlights Bind (doesn't bind)", calls.length === 0 && document.activeElement?.dataset?.action === "bind");
  press("ArrowDown");
  check("ArrowDown moves to Recall", document.activeElement?.dataset?.action === "recall");
  press("Enter");
  check("Enter activates Recall", calls.length === 1 && calls[0][0] === "recall" && p.getAttribute("data-open") === "0");
  dispose();
});

// ── Hover tooltip ──────────────────────────────────────────────────────
console.log("== hover tooltip ==");
const tip = await load("plugins/hover-tooltip.js");
await guard("tooltip", async () => {
  window.__pickEntityAt = () => 0xBEEF;
  window.liveScene3d = { entityManager: { entityMap: new Map([[0xBEEF, { meta: { name: "Banderling Scout", level: 9, currentHealth: 10, maxHealth: 40 } }]]) } };
  const dispose = tip.mount({ client: window.__pluginClient });
  const ev = new Ev("mousemove", { clientX: 1270, clientY: 710 });
  window._fire(ev, false);
  await new Promise((r) => setTimeout(r, 450));
  const el = document.getElementById("hb-hover-tooltip");
  check("tooltip shown with kit class", el?.classList.contains("hbk-tooltip") && el.style.display === "block");
  check("name + level + meter", /Banderling Scout/.test(el.textContent) && /Level 9/.test(el.textContent) && !!el.querySelector(".hbk-meter"));
  check("flipped/clamped inside the viewport", parseFloat(el.style.left) + 120 <= 1280 && parseFloat(el.style.top) + 40 <= 720, `${el.style.left},${el.style.top}`);
  dispose();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
