// tests/helpers/fake_dom_items.mjs — small fake DOM for the inventory /
// external-container DOM tests (HUD overhaul 2026-10-05). Kept separate
// from tests/helpers/fake_dom.mjs (the social-panel suite's helper) so the
// two suites can evolve their fakes independently.
//
// Supported: tree ops (append/prepend/insertBefore/remove/replaceChildren,
// text nodes), classList, dataset, attributes, style (+ setProperty /
// getPropertyValue), listeners with capture/bubble, click() (checkbox
// toggle + input/change, disabled ignored), focus/blur, hidden,
// getElementById, querySelector(All)/closest/matches for compound selectors
// with descendant/child combinators and comma lists. Unknown pseudo-classes
// (":hover") never match.

export class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
    this.bubbles = init.bubbles !== false;
    this.cancelable = true;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stop = false;
    this._stopNow = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
}

function camel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function kebab(name) {
  return name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

class FakeClassList {
  constructor() { this._s = new Set(); }
  add(...c) { for (const x of c) if (x) this._s.add(String(x)); }
  remove(...c) { for (const x of c) this._s.delete(String(x)); }
  contains(c) { return this._s.has(String(c)); }
  toggle(c, force) {
    const want = force === undefined ? !this._s.has(c) : !!force;
    if (want) this._s.add(c); else this._s.delete(c);
    return want;
  }
  replace(a, b) { if (!this._s.has(a)) return false; this._s.delete(a); this._s.add(b); return true; }
  get length() { return this._s.size; }
  item(i) { return Array.from(this._s)[i] ?? null; }
  toString() { return Array.from(this._s).join(" "); }
  [Symbol.iterator]() { return this._s.values(); }
}

function makeStyle() {
  const t = {};
  return new Proxy(t, {
    get(o, k) {
      if (k === "setProperty") return (n, v) => { o[n] = String(v); };
      if (k === "removeProperty") return (n) => { const v = o[n]; delete o[n]; return v ?? ""; };
      if (k === "getPropertyValue") return (n) => (o[n] ?? "");
      return o[k] ?? "";
    },
    set(o, k, v) { o[k] = v; return true; },
  });
}

export class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
  get previousSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null;
  }
  get isConnected() {
    let n = this;
    while (n) { if (n === this.ownerDocument.documentElement) return true; n = n.parentNode; }
    return false;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

export class FakeText extends FakeNode {
  constructor(doc, text) { super(doc); this.nodeType = 3; this.data = String(text ?? ""); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v ?? ""); }
}

function toNode(doc, n) { return (n instanceof FakeNode) ? n : new FakeText(doc, n); }

export class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.classList = new FakeClassList();
    this.style = makeStyle();
    this._attrs = new Map();
    this._listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.placeholder = "";
    this.draggable = false;
    this.tabIndex = -1;
    this.title = "";
    this.scrollTop = 0;
    this.scrollLeft = 0;
    const self = this;
    this.dataset = new Proxy({}, {
      get(o, k) { return o[k]; },
      set(o, k, v) { o[k] = String(v); self._attrs.set("data-" + kebab(String(k)), String(v)); return true; },
      deleteProperty(o, k) { delete o[k]; self._attrs.delete("data-" + kebab(String(k))); return true; },
    });
  }
  get id() { return this._attrs.get("id") ?? ""; }
  set id(v) { this._attrs.set("id", String(v)); }
  get className() { return this.classList.toString(); }
  set className(v) { this.classList = new FakeClassList(); this.classList.add(...String(v).split(/\s+/).filter(Boolean)); }
  get type() { return this._attrs.get("type") ?? (this.tagName === "INPUT" ? "text" : (this.tagName === "BUTTON" ? "submit" : "")); }
  set type(v) { this._attrs.set("type", String(v)); }
  get children() { return this.childNodes.filter((c) => c instanceof FakeElement); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] ?? null; }
  get childElementCount() { return this.children.length; }
  get nextElementSibling() {
    let n = this.nextSibling;
    while (n && !(n instanceof FakeElement)) n = n.nextSibling;
    return n;
  }
  get previousElementSibling() {
    let n = this.previousSibling;
    while (n && !(n instanceof FakeElement)) n = n.previousSibling;
    return n;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = String(v ?? "");
    if (s) this.appendChild(new FakeText(this.ownerDocument, s));
  }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return this._html ?? ""; }
  set innerHTML(v) { this.textContent = ""; this._html = String(v ?? ""); }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }
  get scrollWidth() { return 0; }
  get scrollHeight() { return 0; }
  get currentCSSZoom() { return 1; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  setAttribute(k, v) {
    const key = String(k);
    const val = String(v);
    if (key === "class") { this.className = val; return; }
    if (key === "hidden") { this.hidden = true; return; }
    if (key === "disabled") { this.disabled = true; return; }
    this._attrs.set(key, val);
    if (key.startsWith("data-")) this.dataset[camel(key.slice(5))] = val;
  }
  getAttribute(k) {
    const key = String(k);
    if (key === "class") return this.className;
    if (key === "hidden") return this.hidden ? "" : null;
    if (key === "disabled") return this.disabled ? "" : null;
    return this._attrs.has(key) ? this._attrs.get(key) : null;
  }
  hasAttribute(k) { return this.getAttribute(k) !== null; }
  removeAttribute(k) {
    const key = String(k);
    if (key === "hidden") { this.hidden = false; return; }
    if (key === "disabled") { this.disabled = false; return; }
    if (key.startsWith("data-")) delete this.dataset[camel(key.slice(5))];
    this._attrs.delete(key);
  }
  toggleAttribute(k, force) {
    const has = this.hasAttribute(k);
    const want = force === undefined ? !has : !!force;
    if (want) this.setAttribute(k, ""); else this.removeAttribute(k);
    return want;
  }
  appendChild(c) { return this.insertBefore(c, null); }
  append(...cs) { for (const c of cs) this.appendChild(toNode(this.ownerDocument, c)); }
  prepend(...cs) { const ref = this.firstChild; for (const c of cs) this.insertBefore(toNode(this.ownerDocument, c), ref); }
  replaceChildren(...cs) { this.textContent = ""; this.append(...cs); }
  insertBefore(c, ref) {
    const node = toNode(this.ownerDocument, c);
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  replaceWith(...nodes) {
    const p = this.parentNode;
    if (!p) return;
    for (const n of nodes) p.insertBefore(toNode(this.ownerDocument, n), this);
    p.removeChild(this);
  }
  before(...nodes) { const p = this.parentNode; if (p) for (const n of nodes) p.insertBefore(toNode(this.ownerDocument, n), this); }
  after(...nodes) { const p = this.parentNode; if (p) { const ref = this.nextSibling; for (const n of nodes) p.insertBefore(toNode(this.ownerDocument, n), ref); } }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  cloneNode(deep) {
    const c = new FakeElement(this.ownerDocument, this.tagName);
    for (const [k, v] of this._attrs) c._attrs.set(k, v);
    c.className = this.className;
    for (const [k, v] of Object.entries(this.dataset)) c.dataset[k] = v;
    if (deep) for (const ch of this.childNodes) c.appendChild(ch instanceof FakeElement ? ch.cloneNode(true) : new FakeText(this.ownerDocument, ch.textContent));
    return c;
  }
  addEventListener(type, fn, opts) {
    if (typeof fn !== "function" && typeof fn?.handleEvent !== "function") return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    this._listeners.get(type).push({ fn, capture, once: !!opts?.once });
  }
  removeEventListener(type, fn, opts) {
    const l = this._listeners.get(type);
    if (!l) return;
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const i = l.findIndex((x) => x.fn === fn && x.capture === capture);
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(ev) { return dispatch(this, ev); }
  click() {
    if (this.disabled) return;
    const isToggle = this.tagName === "INPUT" && (this.type === "checkbox" || this.type === "radio");
    if (isToggle) this.checked = this.type === "radio" ? true : !this.checked;
    dispatch(this, new FakeEvent("click", { button: 0, detail: 1 }));
    if (isToggle) {
      dispatch(this, new FakeEvent("input"));
      dispatch(this, new FakeEvent("change"));
    }
  }
  focus() { this.ownerDocument.activeElement = this; dispatch(this, new FakeEvent("focus", { bubbles: false })); }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  select() {}
  scrollIntoView() {}
  matches(sel) { return matchesSelector(this, sel, null); }
  closest(sel) {
    let n = this;
    while (n instanceof FakeElement) { if (matchesSelector(n, sel, null)) return n; n = n.parentNode; }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (!(c instanceof FakeElement)) continue;
        if (matchesSelector(c, sel, this)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

function dispatch(target, ev) {
  if (!(ev instanceof FakeEvent) && typeof ev === "object") {
    // Accept CustomEvent-like objects from plugin code.
    const fe = new FakeEvent(ev.type, { detail: ev.detail, bubbles: ev.bubbles });
    ev = fe;
  }
  ev.target = target;
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  const win = target.ownerDocument?.defaultView;
  if (ev.bubbles !== false && target.isConnected) {
    path.push(target.ownerDocument);
    if (win) path.push(win);
  }
  const fire = (node, capturePhase) => {
    const list = node._listeners?.get(ev.type);
    if (!list) return;
    for (const l of list.slice()) {
      if (l.capture !== capturePhase && node !== target) continue;
      ev.currentTarget = node;
      try { (typeof l.fn === "function" ? l.fn : l.fn.handleEvent.bind(l.fn)).call(node, ev); }
      catch (e) { console.error(e); }
      if (l.once) node.removeEventListener(ev.type, l.fn, l.capture);
      if (ev._stopNow) return;
    }
  };
  for (let i = path.length - 1; i >= 1 && !ev._stop; i--) fire(path[i], true);
  if (!ev._stop) fire(target, false);
  if (ev.bubbles !== false) {
    for (let i = 1; i < path.length && !ev._stop; i++) fire(path[i], false);
  }
  return !ev.defaultPrevented;
}

function parseCompound(s) {
  const out = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
  const re = /(\*)|([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:([\w-]+(?:\([^)]*\))?)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) continue;
    if (m[2]) out.tag = m[2].toUpperCase();
    else if (m[3]) out.id = m[3];
    else if (m[4]) out.classes.push(m[4]);
    else if (m[5]) out.attrs.push({ name: m[5], op: m[6] || null, value: m[7] ?? m[8] ?? m[9] });
    else if (m[10]) out.pseudo.push(m[10]);
  }
  return out;
}
function matchCompound(el, c, scope) {
  if (!(el instanceof FakeElement)) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const k of c.classes) if (!el.classList.contains(k)) return false;
  for (const a of c.attrs) {
    let got = el.getAttribute(a.name);
    if (got === null && (a.name === "checked" || a.name === "disabled")) got = el[a.name] ? "" : null;
    if (got === null || got === undefined) return false;
    if (a.op) {
      const v = String(a.value ?? "");
      const g = String(got);
      if (a.op === "=" && g !== v) return false;
      if (a.op === "^=" && !g.startsWith(v)) return false;
      if (a.op === "$=" && !g.endsWith(v)) return false;
      if (a.op === "*=" && !g.includes(v)) return false;
      if (a.op === "~=" && !g.split(/\s+/).includes(v)) return false;
    }
  }
  for (const p of c.pseudo) {
    if (p === "scope") { if (el !== scope) return false; continue; }
    if (p === "checked") { if (!el.checked) return false; continue; }
    if (p === "disabled") { if (!el.disabled) return false; continue; }
    if (p.startsWith("not(")) { if (matchesSelector(el, p.slice(4, -1), scope)) return false; continue; }
    return false;
  }
  return true;
}
function matchesSelector(el, sel, scope) {
  return String(sel).split(",").some((part) => {
    const tokens = part.trim().replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    let i = tokens.length - 1;
    if (!matchCompound(el, parseCompound(tokens[i]), scope)) return false;
    let node = el;
    i--;
    while (i >= 0) {
      if (tokens[i] === ">") {
        i--;
        node = node.parentNode;
        if (!matchCompound(node, parseCompound(tokens[i]), scope)) return false;
        i--;
        continue;
      }
      const c = parseCompound(tokens[i]);
      node = node.parentNode;
      while (node instanceof FakeElement && !matchCompound(node, c, scope)) node = node.parentNode;
      if (!(node instanceof FakeElement)) return false;
      i--;
    }
    return true;
  });
}

/** Text a player would see: skips hidden / display:none subtrees; text
 *  nodes joined with single spaces. */
export function visibleText(root) {
  const parts = [];
  const walk = (n) => {
    if (n instanceof FakeText) { if (n.data.trim()) parts.push(n.data.trim()); return; }
    if (!(n instanceof FakeElement)) return;
    if (n.hidden || n.style.display === "none") return;
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Set an input's value the way typing does, firing input + change. */
export function typeInto(input, text) {
  input.focus?.();
  input.value = String(text ?? "");
  dispatch(input, new FakeEvent("input"));
  dispatch(input, new FakeEvent("change"));
}

/**
 * Install document / window shims on `target` (usually globalThis, with
 * `globalThis.window = globalThis` set by the caller). Returns {document}.
 */
export function installFakeDom(target = globalThis) {
  const listeners = new Map();
  const doc = {
    nodeType: 9,
    _listeners: listeners,
    activeElement: null,
    defaultView: target,
    createElement(tag) { return new FakeElement(doc, tag); },
    createElementNS(_ns, tag) { return new FakeElement(doc, tag); },
    createTextNode(t) { return new FakeText(doc, t); },
    createDocumentFragment() { return new FakeElement(doc, "#fragment"); },
    getElementById(id) {
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (!(c instanceof FakeElement)) continue;
          if (c.id === id) return c;
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(doc.documentElement);
    },
    querySelector(sel) { return doc.documentElement.querySelector(sel); },
    querySelectorAll(sel) { return doc.documentElement.querySelectorAll(sel); },
    addEventListener(type, fn, opts) { FakeElement.prototype.addEventListener.call(doc, type, fn, opts); },
    removeEventListener(type, fn, opts) { FakeElement.prototype.removeEventListener.call(doc, type, fn, opts); },
    dispatchEvent(ev) {
      const e = ev instanceof FakeEvent ? ev : new FakeEvent(ev.type, { detail: ev.detail });
      e.target = doc;
      for (const l of (listeners.get(e.type) ?? []).slice()) l.fn.call(doc, e);
      return !e.defaultPrevented;
    },
  };
  doc.documentElement = new FakeElement(doc, "html");
  doc.head = new FakeElement(doc, "head");
  doc.body = new FakeElement(doc, "body");
  doc.documentElement.append(doc.head, doc.body);
  doc.activeElement = doc.body;

  const winListeners = new Map();
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  const shims = {
    document: doc,
    localStorage,
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
    location: { search: "", href: "http://localhost/" },
    navigator: target.navigator ?? { userAgent: "fake-dom" },
    _listeners: winListeners,
    addEventListener(type, fn, opts) { FakeElement.prototype.addEventListener.call(shims._self, type, fn, opts); },
    removeEventListener(type, fn, opts) { FakeElement.prototype.removeEventListener.call(shims._self, type, fn, opts); },
    dispatchEvent(ev) {
      const e = ev instanceof FakeEvent ? ev : new FakeEvent(ev.type, { detail: ev.detail });
      e.target = shims._self;
      for (const l of (shims._self._listeners.get(e.type) ?? []).slice()) l.fn.call(shims._self, e);
      return !e.defaultPrevented;
    },
    getComputedStyle: (el) => ({ position: el?.style?.position || "static", display: el?.style?.display || "block", getPropertyValue: (n) => el?.style?.[n] ?? "" }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    FakeEvent,
  };
  for (const [k, v] of Object.entries(shims)) {
    if (k === "navigator" || k === "location") {
      try { if (!target[k]) Object.defineProperty(target, k, { value: v, configurable: true, writable: true }); } catch (_) {}
      continue;
    }
    try { target[k] = v; } catch (_) { Object.defineProperty(target, k, { value: v, configurable: true, writable: true }); }
  }
  shims._self = target;
  if (!target._listeners) target._listeners = winListeners;
  if (typeof target.CustomEvent !== "function") target.CustomEvent = FakeEvent;
  if (typeof target.Event !== "function") target.Event = FakeEvent;
  if (target !== globalThis) {
    globalThis.document = doc;
    globalThis.localStorage = localStorage;
  }
  return { document: doc, window: target };
}
