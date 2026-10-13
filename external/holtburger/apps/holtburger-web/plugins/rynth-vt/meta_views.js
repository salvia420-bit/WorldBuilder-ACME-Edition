// plugins/rynth-vt/meta_views.js — the DOM renderer for meta views (PLAN
// §2.9 X6, §3.12 ViewManager, §3.16; G:290-292 "Create View … using XML").
//
// The meta's CreateView XML is parsed by formats/view_xml.js (its own
// whitelist tokenizer) into a plain ViewModel; rynth/vt/meta/views.js keeps
// the models and calls THIS renderer:
//
//   createViewRenderer({ doc, onClick }) → {
//     render(name, model) → handle,   one small retail-styled window
//     update(handle, model),          labels / checked / visible changed
//     destroy(handle) }               the window is removed
//
// Controls: button (click → onClick(view, control)), label, checkbox (a click
// asks the ViewManager, which toggles `checked` and calls update), textbox,
// and "unsupported" controls drawn as disabled placeholders. A control with
// `visible === false` is hidden (uisetvisible). All text goes through
// textContent — the XML never reaches the DOM as markup. Windows drag by
// their title bar (no persisted position: views come and go with the meta).

import { ensureVtStyles } from "./styles.js";

const TITLE_H = 25;
let seq = 0;

function px(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * @param {{ doc?: Document, onClick?: (view: string, control: string) => void }} opts
 */
export function createViewRenderer({ doc = globalThis.document, onClick = null } = {}) {
  const click = (view, ctrl) => {
    try {
      if (typeof onClick === "function") onClick(view, ctrl);
    } catch (e) {
      try { console.warn("[rynth-vt] meta view click failed:", e); } catch { /* ignore */ }
    }
  };

  function el(tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function attachDrag(root, bar) {
    let drag = null;
    bar.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const left = parseFloat(root.style.left) || 0;
      const top = parseFloat(root.style.top) || 0;
      drag = { ox: (ev.clientX || 0) - left, oy: (ev.clientY || 0) - top };
      try { bar.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    });
    bar.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      root.style.left = `${Math.max(0, (ev.clientX || 0) - drag.ox)}px`;
      root.style.top = `${Math.max(0, (ev.clientY || 0) - drag.oy)}px`;
    });
    const end = (ev) => {
      drag = null;
      try { bar.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  function buildControl(viewName, c) {
    const type = String(c.type || "unsupported");
    let node;
    if (type === "button") {
      node = el("button", "hbk-btn-small rvt-ctl rvt-ctl-button", c.text);
      node.type = "button";
      node.addEventListener("click", (e) => {
        e?.stopPropagation?.();
        click(viewName, c.name);
      });
    } else if (type === "checkbox") {
      node = el("label", "hbk-label rvt-ctl rvt-ctl-checkbox");
      const cb = el("input", "hbk-check");
      cb.type = "checkbox";
      cb.checked = isChecked(c.checked);
      cb.addEventListener("change", () => {
        // The ViewManager owns `checked`: undo the browser's toggle and let
        // its update() (after the click) set the real state.
        cb.checked = !cb.checked;
        click(viewName, c.name);
      });
      const span = el("span", "rvt-ctl-text", c.text);
      node.append(cb, span);
      node._cb = cb;
      node._text = span;
    } else if (type === "textbox") {
      node = el("input", "hbk-input rvt-ctl rvt-ctl-textbox");
      node.type = "text";
      node.value = String(c.text ?? "");
    } else if (type === "label") {
      node = el("div", "rvt-ctl rvt-ctl-label", c.text);
    } else {
      node = el("div", "rvt-ctl rvt-unsupported", c.text || c.origType || "unsupported");
      node.title = `Unsupported view control${c.origType ? ` "${c.origType}"` : ""} — shown disabled`;
      node.setAttribute("aria-disabled", "true");
    }
    node.dataset.ctrl = String(c.name ?? "");
    node.dataset.type = type;
    node.style.left = `${px(c.left, 0)}px`;
    node.style.top = `${px(c.top, 0)}px`;
    if (px(c.width, 0) > 0) node.style.width = `${px(c.width, 0)}px`;
    if (px(c.height, 0) > 0) node.style.height = `${px(c.height, 0)}px`;
    node.hidden = c.visible === false;
    return node;
  }

  function isChecked(v) {
    return v === true || v === "true" || v === "1" || v === 1;
  }

  function render(name, model) {
    ensureVtStyles(doc);
    const m = model && typeof model === "object" ? model : {};
    const root = el("div", "hbk-window rvt-view");
    root.dataset.view = String(name ?? "");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", String(m.title || name || "View"));
    const n = seq++ % 8;
    root.style.left = `${80 + 28 * n}px`;
    root.style.top = `${140 + 28 * n}px`;
    const w = px(m.width, 0);
    const h = px(m.height, 0);
    if (w > 0) root.style.width = `${w}px`;
    if (h > 0) root.style.height = `${h + TITLE_H}px`;
    const bar = el("div", "hbk-titlebar rvt-view-title");
    const title = el("span", "hbk-title", m.title || name || "");
    bar.appendChild(title);
    root.appendChild(bar);
    const body = el("div", "rvt-view-body");
    if (h > 0) body.style.height = `${h}px`;
    root.appendChild(body);
    const controls = new Map();
    for (const c of Array.isArray(m.controls) ? m.controls : []) {
      if (!c || typeof c !== "object") continue;
      const node = buildControl(String(name ?? ""), c);
      body.appendChild(node);
      controls.set(String(c.name ?? ""), node);
    }
    attachDrag(root, bar);
    doc.body.appendChild(root);
    return { name: String(name ?? ""), root, title, controls };
  }

  function update(handle, model) {
    if (!handle || !handle.root) return;
    const m = model && typeof model === "object" ? model : {};
    const t = String(m.title || handle.name || "");
    if (handle.title && handle.title.textContent !== t) handle.title.textContent = t;
    for (const c of Array.isArray(m.controls) ? m.controls : []) {
      const node = handle.controls.get(String(c?.name ?? ""));
      if (!node) continue;
      node.hidden = c.visible === false;
      const text = String(c.text ?? "");
      if (node._text) {
        if (node._text.textContent !== text) node._text.textContent = text;
        const on = isChecked(c.checked);
        if (node._cb.checked !== on) node._cb.checked = on;
      } else if (node.tagName === "INPUT") {
        if (node.value !== text && node.ownerDocument?.activeElement !== node) node.value = text;
      } else if (node.textContent !== text && !node.classList.contains("rvt-unsupported")) {
        node.textContent = text;
      }
    }
  }

  function destroy(handle) {
    try {
      handle?.root?.remove();
    } catch {
      /* already gone */
    }
  }

  return { render, update, destroy };
}

export default createViewRenderer;
