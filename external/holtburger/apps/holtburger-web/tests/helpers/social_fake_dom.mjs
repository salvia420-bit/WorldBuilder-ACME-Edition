// tests/helpers/social_fake_dom.mjs — a deliberately small DOM for Node
// smoke tests of the social + quest HUD plugins (HUD overhaul 2026-10-05;
// used by tests/social_panel_dom.test.mjs). No layout, no CSS cascade:
// just enough tree / attribute / class / event / selector behaviour that a
// plugin's mount() can build its UI, and a test can find controls, type
// into them and click them. Not a browser — anything visual is verified by
// the orchestrator's screenshots.
//
// Supported selectors: comma lists of descendant chains of compound
// selectors — tag, #id, .class, [attr], [attr='v'] / [attr="v"].

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.detail = init.detail;
    this.key = init.key;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._stop = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; }
}

class Listeners {
  constructor() { this._l = new Map(); }
  addEventListener(type, fn) {
    if (typeof fn !== "function") return;
    if (!this._l.has(type)) this._l.set(type, []);
    this._l.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._l.get(type);
    if (a) this._l.set(type, a.filter((f) => f !== fn));
  }
  _fire(ev) {
    for (const fn of [...(this._l.get(ev.type) || [])]) {
      ev.currentTarget = this;
      fn.call(this, ev);
    }
  }
}

function parseCompound(src) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:'([^']*)'|"([^"]*)"|([^\]]*)))?\]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) c.tag = m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], value: m[5] ?? m[6] ?? m[7] ?? null });
  }
  return c;
}
function matchCompound(el, c) {
  if (el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v == null) return false;
    if (a.value != null && String(v) !== a.value) return false;
  }
  return true;
}
function matchesSelector(el, selector) {
  return selector.split(",").some((part) => {
    const chain = part.trim().split(/\s+/).map(parseCompound);
    if (!chain.length || !matchCompound(el, chain[chain.length - 1])) return false;
    let node = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      while (node && !(node.nodeType === 1 && matchCompound(node, chain[i]))) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

class FakeText {
  constructor(text) { this.nodeType = 3; this._text = String(text); this.parentNode = null; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  remove() { this.parentNode?._removeChild(this); }
}

class ClassList {
  constructor() { this._set = new Set(); }
  add(...c) { for (const x of c) if (x) this._set.add(x); }
  remove(...c) { for (const x of c) this._set.delete(x); }
  toggle(c, force) {
    const on = force === undefined ? !this._set.has(c) : !!force;
    if (on) this._set.add(c); else this._set.delete(c);
    return on;
  }
  contains(c) { return this._set.has(c); }
  toString() { return [...this._set].join(" "); }
}

class Style {
  setProperty(k, v) { this[k] = String(v); }
  removeProperty(k) { delete this[k]; }
  getPropertyValue(k) { return this[k] ?? ""; }
}

class FakeElement extends Listeners {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.dataset = {};
    this.style = new Style();
    this._attrs = new Map();
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.scrollTop = 0;
    this.onclick = null;
    this.currentCSSZoom = 1;
  }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList = new ClassList(); this.classList.add(...String(v).split(/\s+/)); }
  get id() { return this._attrs.get("id") ?? ""; }
  set id(v) { this._attrs.set("id", String(v)); }
  get hidden() { return this._attrs.has("hidden"); }
  set hidden(v) { if (v) this._attrs.set("hidden", ""); else this._attrs.delete("hidden"); }
  get title() { return this._attrs.get("title") ?? ""; }
  set title(v) { this._attrs.set("title", String(v)); }
  setAttribute(k, v) { this._attrs.set(k, String(v)); }
  getAttribute(k) {
    if (k === "class") return this.className || null;
    if (k.startsWith("data-")) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (this.dataset[key] != null) return String(this.dataset[key]);
    }
    if (k === "disabled") return this.disabled ? "" : null;
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) != null; }
  removeAttribute(k) { this._attrs.delete(k); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get isConnected() {
    let n = this;
    while (n) { if (n === this.ownerDocument.documentElement) return true; n = n.parentNode; }
    return false;
  }
  _adopt(n) {
    if (typeof n === "string") n = new FakeText(n);
    if (n.parentNode) n.parentNode._removeChild(n);
    n.parentNode = this;
    return n;
  }
  _removeChild(n) { this.childNodes = this.childNodes.filter((c) => c !== n); n.parentNode = null; }
  appendChild(n) {
    n = this._adopt(n);
    this.childNodes.push(n);
    // <select> takes its first <option>'s value, as a browser does.
    if (this.tagName === "SELECT" && n.tagName === "OPTION" && this.value === "") this.value = n.value;
    return n;
  }
  append(...ns) { for (const n of ns) this.appendChild(n); }
  prepend(...ns) { for (const n of ns.reverse()) { const a = this._adopt(n); this.childNodes.unshift(a); } }
  insertBefore(n, ref) {
    n = this._adopt(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  removeChild(n) { this._removeChild(n); return n; }
  remove() { this.parentNode?._removeChild(this); }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    p._removeChild(this);
    const a = p._adopt(n);
    p.childNodes.splice(i, 0, a);
  }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v != null && String(v) !== "") this.appendChild(new FakeText(v));
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) {
    if (String(v) !== "") throw new Error("social_fake_dom: only innerHTML = '' is supported");
    this.textContent = "";
  }
  _walk(fn) {
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      fn(c);
      c._walk(fn);
    }
  }
  querySelectorAll(sel) { const out = []; this._walk((e) => { if (matchesSelector(e, sel)) out.push(e); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  matches(sel) { return matchesSelector(this, sel); }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (matchesSelector(n, sel)) return n; n = n.parentNode; } return null; }
  dispatchEvent(ev) {
    if (!ev.target) ev.target = this;
    let n = this;
    while (n) {
      if (n._fire) n._fire(ev);
      if (ev._stop || !ev.bubbles) break;
      n = n.parentNode;
    }
    if (!ev._stop && ev.bubbles && this.isConnected) {
      this.ownerDocument._fire(ev);
      this.ownerDocument.defaultView?._fire?.(ev);
    }
    return !ev.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    if (this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio")) {
      this.checked = !this.checked;
      this.dispatchEvent(new FakeEvent("change"));
    }
    if (typeof this.onclick === "function") this.onclick(new FakeEvent("click"));
    this.dispatchEvent(new FakeEvent("click"));
  }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  scrollIntoView() {}
  setSelectionRange() {}
  select() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300, x: 0, y: 0 }; }
  get clientWidth() { return 300; }
}

export function installFakeDom(win = globalThis) {
  const doc = new Listeners();
  doc.documentElement = null;
  doc.activeElement = null;
  doc.defaultView = win;
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.createTextNode = (t) => new FakeText(t);
  const html = new FakeElement(doc, "html");
  doc.documentElement = html;
  doc.head = html.appendChild(new FakeElement(doc, "head"));
  doc.body = html.appendChild(new FakeElement(doc, "body"));
  doc.getElementById = (id) => html.querySelector(`#${id}`);
  doc.querySelector = (s) => html.querySelector(s);
  doc.querySelectorAll = (s) => html.querySelectorAll(s);
  doc.dispatchEvent = (ev) => { if (!ev.target) ev.target = doc; doc._fire(ev); return true; };

  const store = new Map();
  win.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };
  const winL = new Listeners();
  win._fire = (ev) => winL._fire(ev);
  win.addEventListener = (t, f) => winL.addEventListener(t, f);
  win.removeEventListener = (t, f) => winL.removeEventListener(t, f);
  win.dispatchEvent = (ev) => { winL._fire(ev); return true; };
  win.innerWidth = 1280;
  win.innerHeight = 720;
  win.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.getComputedStyle = () => ({ paddingLeft: "0", paddingRight: "0", width: "300px", height: "300px" });
  win.document = doc;
  globalThis.document = doc;
  if (win !== globalThis) globalThis.window = win;
  return { document: doc, FakeEvent };
}

/** Visible text of an element (skips subtrees with the hidden attribute). */
export function visibleText(el) {
  if (!el) return "";
  if (el.nodeType === 3) return el.textContent;
  if (el.hidden) return "";
  return el.childNodes.map(visibleText).join("");
}

/** Set an input's value and fire `input`. */
export function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new FakeEvent("input"));
}
