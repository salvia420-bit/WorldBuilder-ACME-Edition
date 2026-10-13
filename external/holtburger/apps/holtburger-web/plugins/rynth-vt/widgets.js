// plugins/rynth-vt/widgets.js — small DOM builders for the VTank panel
// (PLAN W1-10, §3.16). Every control carries the HUD kit classes
// (ui/hud_kit.js): inputs/textareas `hbk-input`, checkboxes `hbk-check`,
// selects `hbk-select`, buttons `hbk-btn-small`. Text is always set through
// textContent (never innerHTML).
//
// The list/refresh rules of plugins/rynth-hud.js (renderMonsterList,
// :573-582) live here as two helpers:
//   shouldRebuild(container, sig, force)  rebuild only when the data
//                                         signature changed, and never while
//                                         the player is typing in it;
//   setValue(input, v)                    never overwrite a focused control.

/** The document the panel was built in (tests inject a fake one). */
export function docOf(node) {
  return (node && node.ownerDocument) || globalThis.document;
}

export function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

export function btn(doc, text, title, cls = "hbk-btn-small") {
  const b = el(doc, "button", cls, text);
  b.type = "button";
  if (title) b.title = title;
  return b;
}

export function setText(e, v) {
  const s = v == null ? "" : String(v);
  if (e && e.textContent !== s) e.textContent = s;
}

export function setTitle(e, v) {
  const s = v == null ? "" : String(v);
  if (e && e.title !== s) e.title = s;
}

const EDITING_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
// Inputs that hold no typed / chosen-in-progress state: a rebuild under them
// loses nothing (the HUD rebuilds its lists under a clicked button too).
const CLICK_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file"]);

function isEditing(a) {
  const tag = String(a?.tagName || "").toUpperCase();
  if (!EDITING_TAGS.has(tag)) return false;
  return !(tag === "INPUT" && CLICK_INPUT_TYPES.has(String(a.type || "").toLowerCase()));
}

/** True when the player is typing in / choosing from a control inside `container` (or `container` itself). */
export function editingInside(container) {
  const a = docOf(container)?.activeElement;
  if (!a || !container || !isEditing(a)) return false;
  return a === container || !!container.contains?.(a);
}

/**
 * Rebuild guard: the signature changed (or `force`) AND nobody is editing
 * inside — never under a focused control, forced or not (PLAN §3.16, the
 * renderMonsterList rule). A forced rebuild that has to wait marks the
 * container dirty, so it happens on the first refresh after the player leaves
 * the field (and a refused edit gets its stored value back).
 */
export function shouldRebuild(container, sig, force = false) {
  if (!container) return false;
  if (!force && container._rvtSig === sig) return false;
  if (editingInside(container)) {
    if (force) container._rvtSig = undefined;
    return false;
  }
  container._rvtSig = sig;
  return true;
}

/** Set an input/select value unless the player is in it. */
export function setValue(input, v) {
  if (!input) return;
  if (docOf(input)?.activeElement === input) return;
  if (input.type === "checkbox") {
    const on = !!v;
    if (input.checked !== on) input.checked = on;
    return;
  }
  const s = v == null ? "" : String(v);
  if (input.value !== s) input.value = s;
}

export function checkbox(doc, label, title) {
  const lab = el(doc, "label", "hbk-label rvt-check");
  const cb = el(doc, "input", "hbk-check");
  cb.type = "checkbox";
  lab.append(cb, el(doc, "span", null, label));
  if (title) lab.title = title;
  return { lab, cb };
}

export function textInput(doc, placeholder = "", cls = "") {
  const i = el(doc, "input", `hbk-input${cls ? ` ${cls}` : ""}`);
  i.type = "text";
  if (placeholder) i.placeholder = placeholder;
  return i;
}

export function numInput(doc, { min = null, max = null, step = null, placeholder = "", cls = "rvt-num" } = {}) {
  const i = el(doc, "input", `hbk-input${cls ? ` ${cls}` : ""}`);
  i.type = "number";
  if (min != null) i.min = String(min);
  if (max != null) i.max = String(max);
  if (step != null) i.step = String(step);
  if (placeholder) i.placeholder = placeholder;
  return i;
}

export function textArea(doc, placeholder = "", rows = 3) {
  const t = el(doc, "textarea", "hbk-input rvt-textarea");
  t.rows = rows;
  if (placeholder) t.placeholder = placeholder;
  return t;
}

/** <select class="hbk-select"> from [value, text] pairs (or plain values). */
export function select(doc, options = [], cls = "") {
  const s = el(doc, "select", `hbk-select${cls ? ` ${cls}` : ""}`);
  fillSelect(s, options);
  return s;
}

export function fillSelect(s, options) {
  const sig = JSON.stringify(options);
  if (s._rvtOpts === sig) return false;
  const want = s.value;
  s._rvtOpts = sig;
  s.textContent = "";
  s.value = "";
  const doc = docOf(s);
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    const opt = el(doc, "option", null, t);
    opt.value = String(v);
    s.appendChild(opt);
  }
  if (want !== "" && options.some((o) => String(Array.isArray(o) ? o[0] : o) === want)) s.value = want;
  return true;
}

/** <input type=file class="hbk-input"> that hands (file, text|bytes) to onFile. */
export function fileInput(doc, { accept = "", binary = false, title = "" } = {}, onFile) {
  const i = el(doc, "input", "hbk-input rvt-file");
  i.type = "file";
  if (accept) i.accept = accept;
  if (title) i.title = title;
  i.addEventListener("change", async () => {
    const f = i.files && i.files[0];
    if (!f) return;
    try {
      const wantBytes = typeof binary === "function" ? binary(f) : binary;
      const data = wantBytes && typeof f.arrayBuffer === "function" ? new Uint8Array(await f.arrayBuffer()) : await f.text();
      await onFile(f, data);
    } catch (e) {
      await onFile(f, null, e);
    } finally {
      try { i.value = ""; } catch { /* read-only in some engines */ }
    }
  });
  return i;
}

/** Offer `data` (string | Uint8Array) as a file download through a Blob link. */
export function downloadFile(doc, fileName, data, mime = "application/octet-stream") {
  const win = doc.defaultView || globalThis;
  const BlobCtor = win.Blob || globalThis.Blob;
  const URLs = win.URL || globalThis.URL;
  if (typeof BlobCtor !== "function" || !URLs || typeof URLs.createObjectURL !== "function") return false;
  const blob = new BlobCtor([data], { type: mime });
  const url = URLs.createObjectURL(blob);
  const a = el(doc, "a", "rvt-download");
  a.href = url;
  a.download = fileName;
  a.hidden = true;
  doc.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    try { (win.setTimeout || setTimeout)(() => URLs.revokeObjectURL(url), 0); } catch { /* ignore */ }
  }
  return true;
}

/** A section title row (kit look). */
export function sectionTitle(doc, text) {
  return el(doc, "div", "hbk-section-title", text);
}

export function note(doc, text) {
  return el(doc, "div", "rvt-note", text);
}

export function row(doc, ...children) {
  const r = el(doc, "div", "rvt-row");
  r.append(...children.filter(Boolean));
  return r;
}

const fmtNum = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : v == null ? "" : String(v));

/**
 * A typed editor for one settings row (bridge rowView): bool → checkbox,
 * int/float → number, enum → select, string → text. `onCommit(key, value)`
 * fires on change. Returns { wrap, input, update(row) }.
 */
export function optionEditor(doc, r, onCommit) {
  const wrap = el(doc, "div", `rvt-opt${r.inert ? " is-inert" : ""}${r.web ? " is-web" : ""}`);
  wrap.dataset.key = r.key;
  const tip = [r.help, r.vtNames.length ? `VTank: ${r.vtNames.join(", ")}${r.lbf ? " (×240 m when set by this name)" : ""}` : "web option", r.inert ? "not implemented on web — stored and round-tripped only" : ""]
    .filter(Boolean)
    .join(" — ");
  let input;
  if (r.type === "bool") {
    const c = checkbox(doc, r.label, tip);
    input = c.cb;
    wrap.appendChild(c.lab);
    input.addEventListener("change", () => onCommit(r.key, input.checked));
  } else {
    const lab = el(doc, "span", "rvt-opt-label", r.label);
    lab.title = tip;
    wrap.appendChild(lab);
    if (r.type === "enum" && Array.isArray(r.values)) {
      input = select(doc, r.values.map((v) => [String(v), String(v)]));
      input.addEventListener("change", () => {
        const raw = input.value;
        const v = r.values.find((x) => String(x) === raw);
        onCommit(r.key, v === undefined ? raw : v);
      });
    } else if (r.type === "int" || r.type === "float") {
      const step = r.type === "int" ? 1 : r.unit === "power" ? 0.01 : 0.1;
      input = numInput(doc, { min: r.min, max: r.max, step });
      input.addEventListener("change", () => onCommit(r.key, input.value === "" ? r.dflt : Number(input.value)));
    } else {
      input = textInput(doc);
      input.addEventListener("change", () => onCommit(r.key, input.value));
    }
    input.title = tip;
    wrap.appendChild(input);
    if (r.unitText) wrap.appendChild(el(doc, "span", "rvt-unit", r.unitText));
  }
  input.dataset.key = r.key;
  const update = (next) => {
    if (input.type === "checkbox") setValue(input, !!next.value);
    else setValue(input, next.type === "int" || next.type === "float" ? fmtNum(next.value) : next.value);
    wrap.classList.toggle("is-changed", !next.isDefault);
  };
  update(r);
  return { wrap, input, update };
}

/** "12m 03s" / "1h 4m" / "—". */
export function fmtSecs(s) {
  if (s == null || !Number.isFinite(Number(s))) return "—";
  const v = Math.max(0, Math.floor(Number(s)));
  if (v < 60) return `${v}s`;
  const m = Math.floor(v / 60);
  if (m < 60) return `${m}m ${String(v % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
