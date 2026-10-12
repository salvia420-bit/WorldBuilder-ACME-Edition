// rynth/vt/meta/views.js — Meta Views runtime (PLAN §2.9 X6, §3.12; U5 §7).
//
// ViewManager keeps the VIEW MODELS of the meta's CreateView windows and
// drives an optional renderer (plugins/rynth-vt/meta_views.js, W1-10):
//   renderer = { render(name, model) → handle, update(handle, model), destroy(handle) }
// The XML is parsed by the injected `parseXml` (formats/view_xml.js
// parseViewXml: its own element/attribute whitelist tokenizer, D25) — this
// module never sees markup it did not get back as a plain model.
//
// Semantics (U5 §7, corpus ColRings):
//   * create(name, xml) replaces an existing view of the same name;
//   * a button click evaluates `actionexpr` (when non-empty) THEN enters
//     `setstate` (when non-empty); a checkbox click toggles `checked` first;
//     labels, textboxes and unsupported placeholders do nothing on click;
//   * the ui* expression functions: uiviewexists, uiviewvisible,
//     uigetcontrol (handle "<view>/<control>", Err when missing), uisetlabel,
//     uisetvisible.
// View names match case-insensitively; control names exactly first, then
// case-insensitively. The model handed to the renderer is a copy of the
// parsed ViewModel whose controls carry `visible` (false after
// uisetvisible[…,0]).
//
// No DOM access (C1), no imports (C2), never throws (C9).

function text(x) {
  if (x === null || x === undefined) return "";
  return typeof x === "string" ? x : String(x);
}

function errText(e) {
  return e && e.message ? e.message : text(e);
}

function makeLog(log, now) {
  const base = typeof log === "function" ? log : (m) => console.log(`[vt:meta] ${m}`);
  const seen = new Map();
  return (msg) => {
    const m = text(msg);
    let t = 0;
    try {
      t = Number(now()) || 0;
    } catch {
      t = 0;
    }
    const last = seen.get(m);
    if (last !== undefined && t - last < 10_000) return;
    if (seen.size > 256) seen.clear();
    seen.set(m, t);
    try {
      base(m);
    } catch {
      /* ignore */
    }
  };
}

const err = (msg) => ({ t: "err", msg: text(msg) });
const isErrValue = (v) => !!v && typeof v === "object" && v.t === "err";
const CLICKABLE = new Set(["button", "checkbox"]);

function cloneModel(model) {
  const m = model && typeof model === "object" ? model : {};
  const controls = Array.isArray(m.controls) ? m.controls : [];
  return {
    ...m,
    title: text(m.title),
    controls: controls
      .filter((c) => c && typeof c === "object")
      .map((c) => ({ ...c, name: text(c.name), text: text(c.text), visible: c.visible !== false })),
  };
}

export class ViewManager {
  constructor({ parseXml = null, renderer = null, evaluate = null, setState = null, log = null, now = Date.now } = {}) {
    this.parseXml = typeof parseXml === "function" ? parseXml : null;
    this.evaluate = typeof evaluate === "function" ? evaluate : null;
    this.setStateFn = typeof setState === "function" ? setState : null;
    this.log = makeLog(log, typeof now === "function" ? now : Date.now);
    this.renderer = null;
    this._views = new Map(); // lower(name) → { name, model, handle, shown }
    if (renderer) this.setRenderer(renderer);
  }

  /**
   * Additive: attach (or detach with null) the DOM renderer later — the panel
   * module is a lazy import. Existing views are re-rendered on the new one.
   */
  setRenderer(renderer) {
    const r = renderer && typeof renderer.render === "function" ? renderer : null;
    for (const v of this._views.values()) this._unrender(v);
    this.renderer = r;
    for (const v of this._views.values()) this._render(v);
  }

  _render(v) {
    v.handle = null;
    v.shown = false;
    if (!this.renderer) return;
    try {
      v.handle = this.renderer.render(v.name, v.model);
      v.shown = true;
    } catch (e) {
      this.log(`view "${v.name}" render failed: ${errText(e)}`);
    }
  }

  _unrender(v) {
    if (!this.renderer || !v.shown) return;
    try {
      if (typeof this.renderer.destroy === "function") this.renderer.destroy(v.handle);
    } catch (e) {
      this.log(`view "${v.name}" destroy failed: ${errText(e)}`);
    }
    v.handle = null;
    v.shown = false;
  }

  _update(v) {
    if (!this.renderer || !v.shown || typeof this.renderer.update !== "function") return;
    try {
      this.renderer.update(v.handle, v.model);
    } catch (e) {
      this.log(`view "${v.name}" update failed: ${errText(e)}`);
    }
  }

  _get(name) {
    return this._views.get(text(name).trim().toLowerCase()) || null;
  }

  /** Parse + (re)create. → { ok, warnings, error? } */
  create(name, xml) {
    try {
      const n = text(name).trim();
      if (!n) return { ok: false, warnings: [], error: "a view needs a name" };
      if (!this.parseXml) return { ok: false, warnings: [], error: "the view XML parser is not available" };
      const r = this.parseXml(text(xml));
      const warnings = r && Array.isArray(r.warnings) ? r.warnings.map(text) : [];
      for (const w of warnings) this.log(`view "${n}": ${w}`);
      if (!r || !r.ok || !r.model) return { ok: false, warnings, error: text(r && r.error) || "invalid view XML" };
      const old = this._get(n);
      if (old) this._unrender(old);
      const v = { name: n, model: cloneModel(r.model), handle: null, shown: false };
      this._views.set(n.toLowerCase(), v);
      this._render(v);
      return { ok: true, warnings };
    } catch (e) {
      this.log(`create view failed: ${errText(e)}`);
      return { ok: false, warnings: [], error: errText(e) };
    }
  }

  destroy(name) {
    const v = this._get(name);
    if (!v) return { ok: false };
    this._unrender(v);
    this._views.delete(v.name.toLowerCase());
    return { ok: true };
  }

  destroyAll() {
    for (const v of [...this._views.values()]) this._unrender(v);
    this._views.clear();
    return { ok: true };
  }

  exists(name) {
    return this._get(name) !== null;
  }

  /** True while the view exists AND is on screen (a renderer drew it). */
  visible(name) {
    const v = this._get(name);
    return !!(v && v.shown);
  }

  /** Additive: view names (creation order) for the panel / status. */
  list() {
    return [...this._views.values()].map((v) => v.name);
  }

  /** Additive: a copy of a view's current model, or null. */
  model(name) {
    const v = this._get(name);
    return v ? cloneModel(v.model) : null;
  }

  _findControl(v, ctrl) {
    const c = text(ctrl);
    const list = v.model.controls;
    return list.find((x) => x.name === c) || list.find((x) => x.name.toLowerCase() === c.trim().toLowerCase()) || null;
  }

  // "<view>/<control>" → { v, c } | null. The longest matching view-name
  // prefix wins, so names containing "/" still resolve.
  _resolve(handle) {
    const h = text(handle);
    let best = null;
    for (const v of this._views.values()) {
      const p = `${v.name.toLowerCase()}/`;
      if (h.toLowerCase().startsWith(p) && (!best || v.name.length > best.name.length)) best = v;
    }
    if (!best) return null;
    const c = this._findControl(best, h.slice(best.name.length + 1));
    return c ? { v: best, c } : null;
  }

  /** uigetcontrol: the handle string "<view>/<control>", or an Err Value. */
  getControl(view, ctrl) {
    const v = this._get(view);
    if (!v) return err(`uigetcontrol: no view named "${text(view)}"`);
    const c = this._findControl(v, ctrl);
    if (!c) return err(`uigetcontrol: no control "${text(ctrl)}" in view "${v.name}"`);
    return `${v.name}/${c.name}`;
  }

  setLabel(handle, label) {
    const r = this._resolve(handle);
    if (!r) return false;
    r.c.text = text(label);
    this._update(r.v);
    return true;
  }

  setVisible(handle, on) {
    const r = this._resolve(handle);
    if (!r) return false;
    r.c.visible = !!on;
    this._update(r.v);
    return true;
  }

  /** A click from the renderer: actionexpr THEN setstate (U5 §7). → { ok, error? } */
  click(view, ctrl) {
    try {
      const v = this._get(view);
      if (!v) return { ok: false, error: `no view "${text(view)}"` };
      const c = this._findControl(v, ctrl);
      if (!c) return { ok: false, error: `no control "${text(ctrl)}"` };
      if (c.visible === false || !CLICKABLE.has(c.type)) return { ok: false, error: "not clickable" };
      if (c.type === "checkbox") {
        c.checked = !(c.checked === true || c.checked === "true" || c.checked === "1");
        this._update(v);
      }
      // Capture both before running anything: the expression may destroy the view.
      const ax = text(c.actionexpr).trim();
      const ss = text(c.setstate).trim();
      let error = null;
      if (ax && this.evaluate) {
        try {
          const res = this.evaluate(ax);
          if (isErrValue(res)) {
            error = res.msg;
            this.log(`view "${v.name}" ${c.name} actionexpr failed: ${res.msg}`);
          }
        } catch (e) {
          error = errText(e);
          this.log(`view "${v.name}" ${c.name} actionexpr failed: ${error}`);
        }
      }
      if (ss && this.setStateFn) {
        try {
          this.setStateFn(ss);
        } catch (e) {
          error = errText(e);
          this.log(`view "${v.name}" ${c.name} setstate failed: ${error}`);
        }
      }
      return error ? { ok: false, error } : { ok: true };
    } catch (e) {
      this.log(`view click failed: ${errText(e)}`);
      return { ok: false, error: errText(e) };
    }
  }
}

export const VIEW_FUNCTION_NAMES = Object.freeze(["uiviewexists", "uiviewvisible", "uigetcontrol", "uisetlabel", "uisetvisible"]);

function plainTruthy(v) {
  if (v === null || v === undefined || v === false || v === 0) return false;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return !(s === "" || s === "0" || s === "false");
  }
  if (typeof v === "object") return !(v.t === "err" || (v.t === "list" && !(Array.isArray(v.items) && v.items.length)));
  return true;
}

function argText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "object") return v.t === "wobj" ? text(v.name) : "";
  return text(v);
}

/**
 * Register the ui* view functions on an EXPR FunctionRegistry. `views` is a
 * ViewManager or a getter returning one (null ⇒ "no views"). Optional
 * `{ truthy }` (EXPR values.truthy) decides uisetvisible's flag.
 */
export function registerViewFunctions(registry, views, { truthy = null } = {}) {
  if (!registry || typeof registry.define !== "function") return;
  const get = typeof views === "function" ? views : () => views;
  const vm = () => {
    try {
      const v = get();
      return v && typeof v.exists === "function" ? v : null;
    } catch {
      return null;
    }
  };
  const isTrue = typeof truthy === "function" ? truthy : plainTruthy;
  registry.define("uiviewexists", (a) => !!(vm() && vm().exists(argText(a[0]))), { minArgs: 1, maxArgs: 1 });
  registry.define("uiviewvisible", (a) => !!(vm() && vm().visible(argText(a[0]))), { minArgs: 1, maxArgs: 1 });
  registry.define(
    "uigetcontrol",
    (a) => {
      const v = vm();
      return v ? v.getControl(argText(a[0]), argText(a[1])) : err("uigetcontrol: meta views are not available");
    },
    { minArgs: 2, maxArgs: 2 },
  );
  registry.define("uisetlabel", (a) => !!(vm() && vm().setLabel(argText(a[0]), argText(a[1]))), { minArgs: 2, maxArgs: 2 });
  registry.define("uisetvisible", (a) => !!(vm() && vm().setVisible(argText(a[0]), !!isTrue(a[1]))), { minArgs: 2, maxArgs: 2 });
}
