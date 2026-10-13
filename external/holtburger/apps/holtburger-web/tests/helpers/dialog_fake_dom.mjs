// tests/helpers/dialog_fake_dom.mjs — a small DOM for Node tests of
// plugins/modal-dialog.js and its callers (chat-errors-7, 2026-10-13; used by
// tests/modal_dialog_ok_only.test.mjs and tests/popup_string_dialog.test.mjs).
// No layout, no CSS: a tree, attributes (data-* mirrored into dataset, as a
// browser does), inline style, focus, and capture-phase keydown listeners on
// document so press() reaches the dialog's key handler first.

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
    this.defaultPrevented = false;
    this._stop = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; }
}

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
  _fire(ev, capture) {
    for (const l of [...this._l]) {
      if (l.type !== ev.type || l.capture !== capture) continue;
      l.fn.call(this, ev);
      if (ev._stop) return;
    }
  }
}

const dataKey = (attr) => attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class FakeElement extends Listeners {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.tabIndex = 0;
    this.scrollTop = 0;
    this.onclick = null;
    this._attrs = new Map();
    this._text = "";
  }
  get id() { return this._attrs.get("id") ?? ""; }
  set id(v) { this._attrs.set("id", String(v)); }
  setAttribute(k, v) {
    this._attrs.set(k, String(v));
    if (k.startsWith("data-")) this.dataset[dataKey(k)] = String(v);
  }
  getAttribute(k) {
    if (k.startsWith("data-") && this.dataset[dataKey(k)] != null) return String(this.dataset[dataKey(k)]);
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  appendChild(n) {
    if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((c) => c !== n);
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get isConnected() {
    let n = this;
    while (n) { if (n === this.ownerDocument.documentElement) return true; n = n.parentNode; }
    return false;
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v ?? "");
  }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { if (typeof this.onclick === "function") this.onclick(new FakeEvent("click")); }
  _walk(fn) { for (const c of this.children) { if (fn(c)) return c; const hit = c._walk(fn); if (hit) return hit; } return null; }
}

/** Install document / window on globalThis. Returns { document, press }. */
export function installDialogFakeDom() {
  const doc = new Listeners();
  doc.createElement = (tag) => new FakeElement(doc, tag);
  const html = new FakeElement(doc, "html");
  doc.documentElement = html;
  doc.head = html.appendChild(new FakeElement(doc, "head"));
  doc.body = html.appendChild(new FakeElement(doc, "body"));
  doc.activeElement = doc.body;
  doc.getElementById = (id) => html._walk((e) => e.id === id);

  const win = new Listeners();
  globalThis.window = globalThis;
  globalThis.addEventListener = win.addEventListener.bind(win);
  globalThis.removeEventListener = win.removeEventListener.bind(win);
  globalThis.dispatchEvent = (ev) => { win._fire(ev, true); if (!ev._stop) win._fire(ev, false); return true; };
  globalThis.CustomEvent = class extends FakeEvent { constructor(t, i = {}) { super(t, i); this.detail = i.detail; } };
  globalThis.document = doc;

  /** A keydown at the focused element: document capture listeners run first. */
  function press(key) {
    const ev = new FakeEvent("keydown", { key, target: doc.activeElement });
    doc._fire(ev, true);
    if (!ev._stop) doc._fire(ev, false);
    return ev;
  }
  return { document: doc, press };
}

/** Let modal-dialog's `setTimeout(processNext, 0)` run. */
export const tick = () => new Promise((r) => setTimeout(r, 5));
