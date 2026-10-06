// HUD overhaul 2026-10-05 — stub-DOM smoke of plugins/chat-panel.js mount()
// (no browser: the laptop runs targeted node tests only). Drives the real
// app/chat_log.js appendChatLine into a fake #chat-log and a fake #chat-form
// shaped like index.html's, then checks: line mirroring + retail colours,
// filters + empty states, talk-focus prefixes through the form, not-in-world
// draft retention, history recall, click-to-tell, the talk-focus menu, global
// Enter / Esc, the unread pill, retail maximize/restore, teardown.
// Pure-logic coverage lives in test_chat_panel_layout.mjs.
const APP = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

// ---------- minimal DOM ----------
const pending = [];
let activeElement = null;
function parseSel(sel) {
  // compound only: tag? (.class)* ([attr(="v")?])*
  const m = { tag: null, classes: [], attrs: [] };
  const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let x;
  while ((x = re.exec(sel.trim()))) {
    if (x[1]) m.tag = x[1].toUpperCase();
    else if (x[2]) m.classes.push(x[2]);
    else if (x[3]) m.attrs.push([x[3], x[4]]);
  }
  return m;
}
function matchOne(el, sel) {
  if (!el || el.nodeType !== 1) return false;
  if (sel.trim() === ":focus-visible") return false;
  const m = parseSel(sel);
  if (m.tag && el.tagName !== m.tag) return false;
  for (const c of m.classes) if (!el.classList.contains(c)) return false;
  for (const [a, v] of m.attrs) {
    const got = el.getAttribute(a);
    if (got == null) return false;
    if (v != null && got !== v) return false;
  }
  return true;
}
function matches(el, sel) { return sel.split(",").some((s) => matchOne(el, s)); }

class Node_ {
  constructor() { this.parentNode = null; this.childNodes = []; this._listeners = {}; }
  get isConnected() { let n = this; while (n) { if (n === document) return true; n = n.parentNode; } return false; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.childNodes.push(c);
    if (this._observers) for (const o of this._observers) o._queue({ addedNodes: [c] });
    return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); p.childNodes[i] = n; n.parentNode = p; this.parentNode = null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== "" && v != null) this.appendChild(new Text_(String(v))); }
  addEventListener(t, fn, opts) { (this._listeners[t] ||= []).push({ fn, capture: opts === true || !!opts?.capture }); }
  removeEventListener(t, fn) { this._listeners[t] = (this._listeners[t] || []).filter((l) => l.fn !== fn); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    const path = []; let n = this; while (n) { path.push(n); n = n.parentNode; }
    for (const node of path) {
      if (ev._stopped) break;
      ev.currentTarget = node;
      for (const l of (node._listeners[ev.type] || []).slice()) l.fn.call(node, ev);
      if (!ev.bubbles) break;
    }
    return !ev.defaultPrevented;
  }
}
class Text_ extends Node_ { constructor(t) { super(); this.nodeType = 3; this._t = t; } get textContent() { return this._t; } set textContent(v) { this._t = String(v); } }
class Element_ extends Node_ {
  constructor(tag) {
    super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this._attrs = {};
    this.style = new Proxy({ _p: {} }, {
      get: (o, k) => k === "setProperty" ? (a, b) => { o._p[a] = b; } : k === "removeProperty" ? (a) => { delete o._p[a]; } : (o._p[k] ?? ""),
      set: (o, k, v) => { o._p[k] = v; return true; },
    });
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => self._attrs["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())],
      set: (_, k, v) => { self._attrs["data-" + String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = String(v); return true; },
    });
    this.classList = {
      _s: () => new Set((self._attrs.class || "").split(/\s+/).filter(Boolean)),
      add(...c) { const s = this._s(); c.forEach((x) => s.add(x)); self._attrs.class = [...s].join(" "); },
      remove(...c) { const s = this._s(); c.forEach((x) => s.delete(x)); self._attrs.class = [...s].join(" "); },
      toggle(c, f) { const has = this._s().has(c); const want = f === undefined ? !has : !!f; want ? this.add(c) : this.remove(c); return want; },
      contains(c) { return this._s().has(c); },
    };
    this.scrollTop = 0; this.value = ""; this.title = ""; this.tabIndex = 0;
  }
  get className() { return this._attrs.class || ""; } set className(v) { this._attrs.class = v; }
  get id() { return this._attrs.id || ""; } set id(v) { this._attrs.id = v; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get ownerDocument() { return document; }
  setAttribute(a, v) { this._attrs[a] = String(v); }
  getAttribute(a) { return a in this._attrs ? this._attrs[a] : null; }
  hasAttribute(a) { return a in this._attrs; }
  removeAttribute(a) { delete this._attrs[a]; }
  matches(s) { return matches(this, s); }
  closest(s) { let n = this; while (n && n.nodeType === 1) { if (matches(n, s)) return n; n = n.parentNode; } return null; }
  contains(o) { while (o) { if (o === this) return true; o = o.parentNode; } return false; }
  querySelectorAll(s) { const out = []; const walk = (n) => { for (const c of n.children) { if (matches(c, s)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  getBoundingClientRect() { const r = this._rect || { left: 8, top: 612, width: 410, height: 100 }; return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }; }
  getClientRects() { return [1]; }
  get scrollHeight() { return this.children.length * 15; }
  get clientHeight() { return 73; }
  get clientWidth() { return 346; }
  scrollBy(_x, y) { this.scrollTop = Math.max(0, this.scrollTop + y); }
  focus() { activeElement = this; this.dispatchEvent(new Event_("focus")); }
  blur() { if (activeElement === this) activeElement = null; }
  setSelectionRange() {} setPointerCapture() {} releasePointerCapture() {}
  get currentCSSZoom() { return 1; }
}
class Event_ { constructor(type, o = {}) { this.type = type; this.bubbles = !!o.bubbles; this.cancelable = !!o.cancelable; this.defaultPrevented = false; } preventDefault() { this.defaultPrevented = true; } stopPropagation() { this._stopped = true; } }
class Doc_ extends Node_ {
  constructor() { super(); this.nodeType = 9; }
  createElement(t) { return new Element_(t); }
  createTextNode(t) { return new Text_(t); }
  getElementById(id) { const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1 && c.id === id) return c; const r = walk(c); if (r) return r; } return null; }; return walk(this); }
  get activeElement() { return activeElement || this.body; }
}
const document = new Doc_();
const html = document.appendChild(new Element_("html"));
document.documentElement = html;
document.head = html.appendChild(new Element_("head"));
document.body = html.appendChild(new Element_("body"));
globalThis.document = document;
globalThis.Node = { TEXT_NODE: 3 };
const store = {};
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const winListeners = {};
globalThis.window = globalThis;
window.location = { search: "" };
window.innerWidth = 1280; window.innerHeight = 720;
window.addEventListener = (t, fn) => { (winListeners[t] ||= []).push(fn); };
window.removeEventListener = (t, fn) => { winListeners[t] = (winListeners[t] || []).filter((f) => f !== fn); };
window.getComputedStyle = () => ({ position: "fixed", paddingLeft: "0", paddingRight: "0" });
window.getSelection = () => ({ isCollapsed: true });
let rafQ = [];
globalThis.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length; };
globalThis.cancelAnimationFrame = () => {};
const flushRaf = () => { const q = rafQ; rafQ = []; q.forEach((f) => f(0)); };
globalThis.Event = Event_;
globalThis.CustomEvent = class extends Event_ { constructor(t, o = {}) { super(t, o); this.detail = o.detail; } };
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; this.recs = []; }
  observe(t) { (t._observers ||= []).push(this); this.t = t; }
  disconnect() { if (this.t) this.t._observers = this.t._observers.filter((o) => o !== this); }
  _queue(r) { this.recs.push(r); if (this.recs.length === 1) pending.push(() => { const rs = this.recs; this.recs = []; this.cb(rs); }); }
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const flush = () => { while (pending.length) pending.shift()(); };

// ---------- page fixtures: #chat-log + #chat-form like index.html ----------
const chatLog = document.body.appendChild(new Element_("ul")); chatLog.id = "chat-log";
const empty = chatLog.appendChild(new Element_("li")); empty.className = "empty"; empty.textContent = "No messages yet";
const chatTabs = document.body.appendChild(new Element_("div"));
const chatForm = document.body.appendChild(new Element_("form")); chatForm.id = "chat-form";
const chatInput = chatForm.appendChild(new Element_("input")); chatInput.id = "chat-input";
const sent = [];
let inWorld = true;
chatForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!inWorld) return;
  sent.push(chatInput.value);
  appendChatLine(`> ${chatInput.value}`, null);
  chatInput.value = "";
  chatInput.focus();
});

const { initChatLog } = await import(`${APP}/app/chat_log.js`);
const { appendChatLine } = initChatLog({ chatLog, chatTabs });
appendChatLine("You have entered the General channel.", 0);

const { mount } = await import(`${APP}/plugins/chat-panel.js`);
let passed = 0, failed = 0;
const check = (l, c, e = "") => { if (c) { passed++; console.log(`  [OK] ${l}`); } else { failed++; console.log(`  [FAIL] ${l} ${e}`); } };

const dispose = mount({});
flush(); flushRaf();
const ov = document.getElementById("hb-chat-panel");
const api = window.__chatPanel;
check("overlay mounted under body", ov && ov.parentNode === document.body);
check("4 filter buttons, one ac-text label each", ov.querySelectorAll(".hb-chat-filter").length === 4 &&
  ov.querySelectorAll(".hb-chat-filter").every((b) => b.children.length === 1 && b.children[0].tagName === "AC-TEXT"));
const log = ov.querySelector(".hb-chat-log");
check("initial sync mirrored 1 line (empty li skipped)", log.childElementCount === 1, String(log.childElementCount));
check("system line is retail green", log.children[0].style.color === "#80ff7f");
appendChatLine('Bob tells you, "hi"', 2); flush();
appendChatLine('[Trade] Sir Fancy says, "wts"', 12); flush();
check("3 lines after live appends", log.childElementCount === 3);
const tellLine = log.children[1];
check("tell line yellow + tell group", tellLine.style.color === "#ffff3f" && tellLine.dataset.grp === "tell");
check("sender name is a clickable span", tellLine.querySelector(".hb-chat-name")?.textContent === "Bob");
check("line text intact", tellLine.textContent.endsWith('Bob tells you, "hi"'));
api.setFilter("tell");
check("filter attr on log", log.dataset.filter === "tell" && ov.dataset.empty === "0");
api.setFilter("local");
check("empty state for Local", ov.dataset.empty === "1" && ov.querySelector(".hb-chat-empty").textContent === "No nearby chat yet.");
api.setFilter("all");
// talk focus + submit
api.setTalkFocus("general");
const input = ov.querySelector(".hb-chat-input");
input.value = "wts keys";
input.dispatchEvent(Object.assign(new Event_("keydown", { bubbles: true }), { key: "Enter" }));
flush();
check("General focus sends /cg prefix through #chat-form", sent.at(-1) === "/cg wts keys", JSON.stringify(sent));
check("input cleared after accepted send", input.value === "");
check("Enter-send leaves chat mode (retail HandleEnterKey)", document.activeElement !== input);
check("echo mirrored", log.children.at(-1).textContent.includes("> /cg wts keys"));
inWorld = false;
input.value = "hello";
ov.querySelector(".hb-chat-send").dispatchEvent(new Event_("click", { bubbles: true }));
check("not-in-world send keeps the draft + flags error", input.value === "hello" && input.classList.contains("is-error"));
inWorld = true;
input.value = "/a hi";
ov.querySelector(".hb-chat-send").dispatchEvent(new Event_("click", { bubbles: true }));
check("typed /command not double-prefixed", sent.at(-1) === "/a hi");
// history
input.dispatchEvent(Object.assign(new Event_("keydown", { bubbles: true }), { key: "ArrowUp" }));
check("ArrowUp recalls last sent", input.value === "/a hi");
// click-to-tell
tellLine.querySelector(".hb-chat-name").dispatchEvent(new Event_("click", { bubbles: true }));
check("click sender → Tell focus + 'Bob, '", api.state().talkFocus === "tell" && input.value === "Bob, " && document.activeElement === input);
// menu
const target = ov.querySelector(".hb-chat-target");
target.dispatchEvent(new Event_("click", { bubbles: true }));
const menu = ov.querySelector(".hb-chat-menu");
check("menu opens", menu.dataset.open === "1" && target.getAttribute("aria-expanded") === "true");
menu.querySelector('[data-focus="fellowship"]').dispatchEvent(new Event_("click", { bubbles: true }));
check("menu pick sets focus + closes", api.state().talkFocus === "fellowship" && menu.dataset.open === "0");
// global Enter opens chat
input.blur();
const ev = Object.assign(new Event_("keydown", { bubbles: true }), { key: "Enter" });
document.dispatchEvent(ev);
check("Enter in game focuses chat input", document.activeElement === input && ev.defaultPrevented);
// Esc blurs
input.dispatchEvent(Object.assign(new Event_("keydown", { bubbles: true }), { key: "Escape" }));
check("Esc leaves chat", document.activeElement !== input);
// unread pill: user scrolled up
log.scrollTop = 0; for (let i = 0; i < 10; i++) appendChatLine(`line ${i}`, 0); flush();
log.scrollTop = 0; log.dispatchEvent(new Event_("scroll"));
appendChatLine('Ann says, "yo"', 1); flush();
const pill = ov.querySelector(".hb-chat-pill");
check("scrolled-up + new line → pill", pill.classList.contains("is-visible") && pill.textContent.startsWith("1 new message"), pill.textContent);
pill.dispatchEvent(new Event_("click", { bubbles: true }));
check("pill click re-pins + clears", api.state().pinned && !pill.classList.contains("is-visible"));
// maximize
api.toggleMaximize();
check("maximize grows, sentinel stored", ov.dataset.maximized === "1" && store.hb_chat_panel_saved_height === "100" && ov.style.height === "460px", ov.style.height);
api.toggleMaximize();
check("restore", ov.dataset.maximized === "0" && !("hb_chat_panel_saved_height" in store) && ov.style.height === "100px", ov.style.height);
// teardown
dispose();
check("teardown removes overlay + api", !document.getElementById("hb-chat-panel") && window.__chatPanel === undefined);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
