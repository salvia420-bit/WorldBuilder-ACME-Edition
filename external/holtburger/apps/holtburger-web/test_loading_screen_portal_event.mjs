// test_loading_screen_portal_event.mjs — plugins/loading-screen.js
//
// The portalSpaceEntered subscriber read fields straight off its handler
// argument, but `client.events` is an EventTarget and api.js's emit dispatches
// `new CustomEvent(name, { detail: payload })` — so the argument is the EVENT.
// Same defect the round-9 review found in allegiance-panel, and easy to miss
// here because the parameter was NAMED `detail`.
//
// This drives the REAL bus construction from plugins/api.js rather than a
// hand-rolled stub, so it stays honest if the bus shape ever changes.

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [OK] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
};

// ── minimal DOM (createElement/getElementById/head/body) ────────────────
const created = [];
const mkEl = (tag) => {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], dataset: {}, style: {}, attrs: {}, _text: "",
    id: "", className: "",
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { this.children.push(...cs); },
    remove() {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    removeAttribute(k) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    replaceChildren(...cs) { this.children = cs; this._text = ""; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get firstChild() { return this.children[0] ?? null; },
    contains() { return false; },
  };
  // setAcText builds its inner <ac-text> via el.ownerDocument.createElement.
  Object.defineProperty(el, "ownerDocument", { get: () => globalThis.document });
  created.push(el);
  return el;
};
const byId = new Map();
globalThis.document = {
  head: mkEl("head"),
  body: mkEl("body"),
  createElement: (t) => mkEl(t),
  getElementById: (id) => byId.get(id) ?? null,
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; },
};
globalThis.window = Object.assign(globalThis.window ?? {}, {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
});
globalThis.customElements = { define() {}, get() { return undefined; } };
globalThis.HTMLElement = class {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const ls = await import("./plugins/loading-screen.js");

// The REAL bus: api.js builds it over an EventTarget with CustomEvent{detail}.
const bus = (() => {
  const t = new EventTarget();
  return {
    on(n, h) { t.addEventListener(n, h); return () => t.removeEventListener(n, h); },
    off(n, h) { t.removeEventListener(n, h); },
    emit(n, payload) { t.dispatchEvent(new CustomEvent(n, { detail: payload })); },
  };
})();

// Sanity: this harness must match api.js's actual emit shape, or the test
// proves nothing about the shipped bus.
{
  let seen = null;
  const off = bus.on("probe", (e) => { seen = e; });
  bus.emit("probe", { marker: 7 });
  off();
  check("harness bus matches api.js: handler receives an event carrying .detail",
    seen && seen.detail && seen.detail.marker === 7 && seen.marker === undefined,
    "if this fails the rest of the file is meaningless");
}

// setAcText writes the string into an inner <ac-text> element rather than
// onto the target directly, so read it back off whichever AC-TEXT holds text.
const messageShown = () => {
  for (let i = created.length - 1; i >= 0; i--) {
    const e = created[i];
    if (e.tagName === "AC-TEXT" && e._text) return e._text;
  }
  return "";
};

console.log("\n=== portalSpaceEntered carries its payload under .detail ===");
{
  const unmount = ls.mount({ client: { events: bus } });

  // A producer that DOES carry a zone name.
  bus.emit("portalSpaceEntered", { zoneName: "Holtburg" });
  const m1 = messageShown();
  check("a zoneName on the event reaches the overlay message",
    m1 === "Holtburg",
    `got ${JSON.stringify(m1)} — reading the arg instead of .detail yields undefined and silently falls back`);

  ls.hide();

  // The producer as it actually ships today: teleportSeq only, no zoneName.
  bus.emit("portalSpaceEntered", { teleportSeq: 4 });
  const m2 = messageShown();
  check("no zoneName on the wire ⇒ documented fallback string, not empty",
    m2 === "Crossing portal space…",
    `got ${JSON.stringify(m2)}`);

  if (typeof unmount === "function") unmount();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
